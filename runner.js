#!/usr/bin/env node
/**
 * The MXC confinement runner: the argv-prefix wrapper the sandbox seam spawns
 * in place of the caller's command.
 *
 * It builds the MXC `1.0.0` request for this exact invocation, runs
 * `wxc-exec.exe` around it with the caller's stdio inherited (bytes flow straight
 * through), mirrors the wrapped command's exit status, and removes the private
 * temp directory and request file it created. It holds no standing state: the
 * provider owns no ACEs, and MXC revokes what it applied when the request ends.
 *
 * Stable argv contract (the provider builds it; see {@link ./src/argv.js}):
 *   [node, runner.js, '--workspace', <dir>, '--mode', <read-only|workspace-write>,
 *    '--exec', <wxc-exec path>, ['--temp', <dir>], '--containment', <name>,
 *    '--network', <allow|deny>, '--environment', <child|child+profile>,
 *    '--container-id', <id>, '--dacl-mutation', <allow|deny>,
 *    ['--read-only-root', <dir>]..., ['--denied-path', <dir>]...,
 *    ['--denial-report', <path>], ['--retain-etl'], ['--preserve-policy'],
 *    ['--mxc-arg', <arg>]..., ['--print-config'], '--', <argv...>]
 *
 * Modes:
 *  - `workspace-write`: the workspace and a private temp directory created inside
 *    `--temp` are granted read-write; TMP/TEMP point at that directory.
 *  - `read-only`: nothing is granted writable, and the ambient temp entries are
 *    left untouched.
 *  Both modes grant the workspace for READING, because MXC's AppContainer tiers
 *  have no ambient read access: without that grant ordinary commands cannot
 *  read their own inputs.
 *
 * Failure contract: every runner-side failure (bad arguments, missing
 * directories, an unusable executor, MXC's own refusal) prints
 * `${RUNNER_SIGNATURE}: <detail>` to stderr and exits 127 — the provider's
 * `runnerFailureRules` match exactly that signature, so the consumer reports
 * `SANDBOX_UNAVAILABLE` instead of a task failure. The wrapped command is NEVER
 * run unconfined.
 *
 * @module dsh-sandbox-windows-mxc/runner
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFromFacts, parseRunnerArgv, RUNNER_USAGE } from './src/argv.js'
import {
  RUNNER_FAILURE_EXIT,
  RUNNER_SIGNATURE,
  SUBPROCESS_CONTROL_MARKER,
  appendTail,
  finalLine,
  missingLaunchRequirements,
  mxcErrorEnvelopeCode,
} from './src/classify.js'
import { assertTempRootOutsideWorkspace, canonicalPath } from './src/paths.js'
import { buildMxcRequest, childEnvironment, containerIdFor } from './src/policy.js'
import { windowsCommandLine } from './src/quote.js'

/** The request file MXC reads, inside this run's private scratch directory. */
const CONFIG_FILE_NAME = 'mxc-request.json'

/** The scratch directory prefix (holds the request file; nothing in it is granted). */
const SCRATCH_PREFIX = 'dsh-mxc-config-'

/** The private writable temp directory prefix (granted to the child under workspace-write). */
const PRIVATE_TEMP_PREFIX = 'dsh-mxc-'

/** Reported when the child's exit status has no code (terminated without one). */
const TERMINATED_EXIT_CODE = 1

class RunnerFailure extends Error {}

/**
 * Report a runner-side failure under the signature the seam matches, and unwind.
 * @param detail - the operator-facing reason.
 */
function fail(detail) {
  process.stderr.write(RUNNER_SIGNATURE + ': ' + detail + '\n')
  throw new RunnerFailure(detail)
}

/**
 * Require an existing directory.
 * @param label - the flag name to blame.
 * @param path - the path to check.
 */
function requireDirectory(label, path) {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    fail(label + ' is not an existing directory: ' + path)
  }
}

/**
 * Remove one directory this runner created. Cleanup failures are reported and
 * never mask the wrapped command's exit status; leftover temp litter is inert.
 * @param path - the directory to remove.
 */
function removeDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    process.stderr.write(RUNNER_SIGNATURE + ': cleanup: ' + (error instanceof Error ? error.message : String(error)) + '\n')
  }
}

/**
 * Run the MXC executor around one written request.
 *
 * stderr is piped so MXC's own refusal (a JSON error envelope after whatever the
 * script printed) can be recognised, and relayed verbatim either way; stdout and
 * stdin are inherited so the wrapped command's bytes are never re-framed.
 * @param facts - the parsed runner arguments.
 * @param configPath - the written request file.
 * @returns the exit status to mirror.
 */
async function runExecutor(facts, configPath) {
  const child = spawn(facts.execPath, [...facts.mxcArgs, configPath], {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: process.env,
  })
  let tail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    tail = appendTail(tail, chunk)
  })
  const outcome = await new Promise((settle) => {
    child.once('error', (error) => { settle({ error }) })
    child.once('close', (code) => { settle({ code }) })
  })
  if (outcome.error !== undefined) {
    fail('cannot start ' + facts.execPath + ': ' + outcome.error.message)
  }
  const code = outcome.code ?? TERMINATED_EXIT_CODE
  if (code !== 0) {
    const envelope = mxcErrorEnvelopeCode(tail)
    if (envelope !== undefined) {
      fail('MXC refused the request (' + envelope + '): ' + String(finalLine(tail)))
    }
  }
  return code
}

/** Build this invocation's request and the environment its child receives. */
function prepare(facts, workspaceRoot, privateTempDir) {
  const env = childEnvironment(process.env, privateTempDir)
  if (facts.environment === 'child') {
    const missing = missingLaunchRequirements(env)
    if (missing.length > 0) {
      fail('MXC refuses an explicit environment without ' + missing.join(', ')
        + '; set environment: child+profile in the plugin configuration')
    }
  }
  return buildMxcRequest({
    config: configFromFacts(facts),
    mode: facts.mode,
    workspaceRoot,
    privateTempDir,
    commandLine: windowsCommandLine(facts.argv),
    // The harness spawns this runner with the session's working directory, so
    // the runner's own cwd IS the command's cwd — MXC must be told explicitly
    // because an omitted cwd lets the backend pick its own default.
    cwd: process.cwd(),
    env,
    containerId: facts.containerId ?? containerIdFor(workspaceRoot),
  })
}

async function main() {
  let facts
  try {
    facts = parseRunnerArgv(process.argv.slice(2))
  } catch (error) {
    fail((error instanceof Error ? error.message : String(error)) + '\n' + RUNNER_USAGE)
  }
  if (process.env[SUBPROCESS_CONTROL_MARKER] !== undefined) {
    fail('the DSH subprocess control channel is not forwardable through MXC: '
      + 'wxc-exec takes a JSON request, not an inherited descriptor at fd 7')
  }
  const workspaceRoot = canonicalPath(facts.workspaceRoot)
  requireDirectory('--workspace', workspaceRoot)
  if (facts.mode === 'workspace-write') {
    requireDirectory('--temp', facts.tempRoot)
    try {
      assertTempRootOutsideWorkspace(workspaceRoot, facts.tempRoot)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  const scratchDir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
  let privateTempDir
  try {
    if (facts.mode === 'workspace-write') privateTempDir = mkdtempSync(join(facts.tempRoot, PRIVATE_TEMP_PREFIX))
    const request = prepare(facts, workspaceRoot, privateTempDir)
    if (facts.printConfig) {
      // The request carries the child's whole environment, so the print is as
      // sensitive as that environment. The note goes to stderr (stdout stays a
      // parseable request) and the exit status is 0, so no consumer can read it
      // as a runner failure.
      process.stderr.write(RUNNER_SIGNATURE + ': note: this request contains the full child environment, including any credentials in it\n')
      process.stdout.write(JSON.stringify(request, null, 2) + '\n')
      return 0
    }
    const configPath = join(scratchDir, CONFIG_FILE_NAME)
    writeFileSync(configPath, JSON.stringify(request), 'utf8')
    return await runExecutor(facts, configPath)
  } finally {
    removeDirectory(scratchDir)
    if (privateTempDir !== undefined) removeDirectory(privateTempDir)
  }
}

main().then(
  (exitCode) => { process.exitCode = exitCode },
  (error) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(RUNNER_SIGNATURE + ': ' + (error instanceof Error ? error.message : String(error)) + '\n')
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
