/**
 * MXC-backed Windows process-sandbox provider for the DeepSeek Harness
 * `ctx.sandbox` seam.
 *
 * It wraps an exact subprocess argv in a runner that drives Microsoft's
 * eXecution Container (MXC) `ProcessContainer` backend: MXC applies the file
 * policy, launches the command inside its containment, and the runner mirrors
 * the command's exit status. Mount this provider in place of
 * `@deepseek-ai/dsh-sandbox-local` on Windows; the seam must always have exactly
 * one `ctx.sandbox` provider.
 *
 * The provider itself is stateless: it resolves policy, derives the runner argv,
 * and reports the facts the consumer classifies with. Nothing is applied to the
 * host until a confined command runs, and MXC revokes its own ACEs when the
 * request ends unless the operator asks for `clearPolicyOnExit: false`.
 *
 * Fail-closed: a missing or unusable MXC executor, and a non-Windows host, both
 * reject with `SANDBOX_UNAVAILABLE`. A command is never run unconfined.
 *
 * @module dsh-sandbox-windows-mxc
 */

import { tmpdir } from 'node:os'
import { SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { buildRunnerArgv } from './src/argv.js'
import { ENFORCEMENT, RUNNER_FAILURE_RULES } from './src/classify.js'
import { denialDialect } from './src/denial.js'
import { normalizeConfig } from './src/config.js'
import { locateMxcExec, locateRunnerEntry } from './src/locate.js'
import { buildMxcRequest, childEnvironment, containerIdFor } from './src/policy.js'
import { SUPPORTED, UNPROBED, verifyContract } from './src/contract.js'
import { windowsCommandLine } from './src/quote.js'

/** Deduplicate canonical roots while preserving the operator's order. */
function unique(paths) {
  return [...new Set(paths)]
}

/** Require the policy root every confined mode must carry. */
function requireWorkspaceRoot(policy) {
  const root = policy?.workspaceRoot
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('dsh-sandbox-windows-mxc: a confined policy must carry a non-empty workspaceRoot')
  }
  return root
}

/**
 * Windows process-sandbox provider backed by MXC's `ProcessContainer`
 * containment. Registers as `ctx.sandbox`.
 *
 * Configuration is validated at mount time; the request each command runs under
 * is derived per call from the caller's resolved policy, so concurrent sessions
 * over one workspace never share a boundary.
 */
export class MxcSandboxProvider extends SandboxProvider {
  /**
   * Test hooks, mirroring the shipped rungs' `internals`: replace the platform,
   * the resolved executor, and the runner entry.
   * @type {{ platform?: string, execPath?: string, runnerEntry?: string, denialDialect?: () => string[], verifyContract?: (request: object) => string | { detail: string } }}
   */
  internals = {}

  /**
   * @param ctx - the cordis context the service registers on.
   * @param config - the row's `config` mapping; see the README's configuration table.
   */
  constructor(ctx, config) {
    super(ctx)
    this.config = normalizeConfig(config)
    this.runnerPath = undefined
    // Resolved on the first confined call, like the shipped rungs' cached probe
    // verdict: mounting the plugin stays free, and a host that never confines
    // never pays for reading the message table.
    this.denialSignatures = undefined
    // Cached contract verdict, like the denial dialect and the shipped local
    // backend's probe: resolved on the first confined call.
    this.contractVerdict = undefined
    if (process.platform !== 'win32') {
      this.ctx.logger.warn('dsh-sandbox-windows-mxc: mounted on ' + process.platform
        + ', where MXC ProcessContainer confinement is unavailable; every confine() call fails closed. '
        + 'Use @deepseek-ai/dsh-sandbox-local on this host.')
    }
  }

  /**
   * Verify once per provider that the executor accepts the request shape and
   * contract this plugin sends, and fail closed when it does not: MXC refusing
   * a request is the sandbox being unavailable, not the command failing.
   * @param mode - the confined mode this call runs under.
   * @param execPath - the executor this call will spawn.
   * @param argv - the caller's exact argv, so the probed request is representative.
   * @param workspaceRoot - the canonical workspace boundary.
   * @throws SandboxUnavailableError carrying MXC's own refusal text.
   */
  assertContractSupported(mode, execPath, argv, workspaceRoot) {
    if (this.contractVerdict === SUPPORTED) return
    const verify = this.internals.verifyContract
      ?? (request => verifyContract({ execPath, request }))
    const request = buildMxcRequest({
      config: this.config,
      mode,
      workspaceRoot,
      privateTempDir: mode === 'workspace-write' ? tmpdir() : undefined,
      commandLine: windowsCommandLine(argv),
      cwd: process.cwd(),
      // The probe never launches the command, so an empty environment cannot
      // make it lie about the request's shape: MXC parses and validates only.
      env: {},
      containerId: containerIdFor(workspaceRoot, undefined),
    })
    const verdict = verify(request)
    if (typeof verdict === 'string') {
      if (verdict === SUPPORTED) this.contractVerdict = SUPPORTED
      return
    }
    throw new SandboxUnavailableError(mode, 'the installed MXC executor refuses this request: ' + verdict.detail
      + ' — set contractVersion to a version the executor supports, or upgrade wxc-exec')
  }

  /**
   * The denial dialect for this provider, resolved once: the static English
   * wordings, this host's own localized `ERROR_ACCESS_DENIED` wording, and the
   * operator's extra substrings.
   * @returns the dialect consumers match denied stderr against.
   */
  resolveDenialSignatures() {
    this.denialSignatures ??= this.internals.denialDialect?.()
      ?? denialDialect({ extra: this.config.denialSignatures })
    return this.denialSignatures
  }

  /**
   * Wrap `argv` so it runs inside MXC's containment under `policy`.
   *
   * Synchronous on purpose. The seam's contract version decides how consumers
   * call this: dsh 0.1.x declares `confine(argv, policy): ConfinedArgv` and
   * reads `confined.argv` on the spot, while later revisions declare a
   * `Promise` and `await` it. Returning the value directly satisfies both —
   * `await` on a non-promise yields the value — whereas returning a promise
   * breaks the synchronous consumers outright. Everything this method does
   * (canonicalizing the root, locating the executor, the once-per-provider
   * contract probe, reading the denial dialect) is already synchronous, so
   * nothing is lost.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param signal - optional cancellation, checked before the wrapped argv is produced.
   * @returns the runner argv plus this backend's enforcement completeness,
   *   denial dialect, and runner-failure rules.
   * @throws SandboxUnavailableError when this host has no usable MXC executor.
   */
  confine(argv, policy, signal) {
    signal?.throwIfAborted()
    const mode = policy?.mode
    if (mode !== 'read-only' && mode !== 'workspace-write') {
      throw new Error('dsh-sandbox-windows-mxc: confine() accepts the confined modes read-only and workspace-write; received '
        + JSON.stringify(mode))
    }
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error('dsh-sandbox-windows-mxc: confine() requires the non-empty argv the caller is about to spawn')
    }
    const workspaceRoot = canonicalPath(requireWorkspaceRoot(policy))
    const platform = this.internals.platform ?? process.platform
    if (platform !== 'win32') {
      throw new SandboxUnavailableError(mode, 'dsh-sandbox-windows-mxc confines on Windows only (MXC ProcessContainer); this host is ' + platform)
    }
    let execPath
    try {
      execPath = this.internals.execPath ?? locateMxcExec({ configuredPath: this.config.execPath })
    } catch (error) {
      throw new SandboxUnavailableError(mode, error instanceof Error ? error.message : String(error))
    }
    this.runnerPath ??= this.internals.runnerEntry ?? locateRunnerEntry()
    this.assertContractSupported(mode, execPath, argv, workspaceRoot)
    signal?.throwIfAborted()
    return {
      argv: buildRunnerArgv({
        nodePath: process.execPath,
        runnerPath: this.runnerPath,
        argv,
        mode,
        workspaceRoot,
        execPath,
        // workspace-write promises a temp area: the runner creates this call's
        // private directory inside the ambient temp root and publishes it as
        // TMP/TEMP. read-only grants nothing, so it names no temp root at all.
        tempRoot: mode === 'workspace-write' ? tmpdir() : undefined,
        containment: this.config.containment,
        contractVersion: this.config.contractVersion,
        network: this.config.network,
        environment: this.config.environment,
        ui: this.config.ui,
        clipboard: this.config.clipboard,
        allowInputInjection: this.config.allowInputInjection,
        readOnlyRoots: unique(this.config.readOnlyRoots.map(canonicalPath)),
        deniedPaths: unique(this.config.deniedPaths.map(canonicalPath)),
        containerId: containerIdFor(workspaceRoot, policy.sessionId),
        allowDaclMutation: this.config.allowDaclMutation,
        preservePolicy: !this.config.clearPolicyOnExit,
        denialReport: this.config.denialReport,
        retainEtl: this.config.retainEtl,
        mxcArgs: this.config.mxcArgs,
      }),
      enforcement: ENFORCEMENT,
      denialSignatures: this.resolveDenialSignatures(),
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }
}

export default MxcSandboxProvider
