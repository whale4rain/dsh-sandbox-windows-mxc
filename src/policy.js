/**
 * The pure policy translation: one DSH file-effect policy plus operator
 * configuration becomes one MXC `1.0.0` request document.
 *
 * The mapping is deliberately one-directional and total — the runner never
 * invents a grant, and every field it sends is derived here, so the whole
 * confinement decision is reviewable and testable without spawning anything.
 * The runner's `--print-config` prints exactly this document.
 *
 * @module dsh-sandbox-windows-mxc/policy
 */

import { createHash } from 'node:crypto'
import { SUBPROCESS_CONTROL_MARKER } from './classify.js'

/** The exact MXC contract this plugin speaks. */
export const MXC_CONTRACT_VERSION = '1.0.0'

/** The environment names the temp rewrite replaces (see {@link childEnvironment}). */
const TEMP_ENVIRONMENT_KEYS = new Set(['TMP', 'TEMP'])

/**
 * Derive the container identifier MXC tracks this invocation's policy under.
 *
 * MXC warns that concurrent Windows policy mutations need distinct container
 * ids, and the seam runs sessions concurrently over one workspace. Deriving the
 * id from the canonical workspace plus the calling session keeps concurrent
 * sessions distinct while making one session's repeated calls reuse MXC's own
 * policy bookkeeping. A session-less (agentless) call falls back to the
 * workspace alone, like the shipped rung's per-call state.
 * @param workspaceRoot - the canonical policy root.
 * @param sessionId - the calling session identity, when there is one.
 * @returns a stable, path-free container id.
 */
export function containerIdFor(workspaceRoot, sessionId) {
  const identity = JSON.stringify(sessionId === undefined ? [workspaceRoot] : [workspaceRoot, String(sessionId)])
  return `dsh-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

/**
 * The environment a confined child receives: the runner's own (already
 * scrubbed and explicitly assembled by the caller's subprocess service) map,
 * with this plugin's internal markers withheld and the private temp area
 * published as TMP/TEMP so tools that write temp files write where the policy
 * grants.
 *
 * Keys are matched case-insensitively because Windows environment blocks are
 * case-insensitive: a surviving `Temp` entry would otherwise shadow the grant.
 * @param env - the runner's ambient environment.
 * @param privateTempDir - the granted private temp directory, or undefined
 *   under `read-only`, where nothing is writable and the ambient temp entries
 *   are left alone.
 * @returns the child environment as a plain object.
 */
export function childEnvironment(env, privateTempDir) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    const name = key.toUpperCase()
    // The control marker is the harness's internal launch protocol, never the
    // child's business. The temp entries are replaced only where a grant
    // exists: under read-only nothing is writable, and silently dropping the
    // ambient entries would change the environment for no boundary.
    if (name === SUBPROCESS_CONTROL_MARKER) continue
    if (privateTempDir !== undefined && TEMP_ENVIRONMENT_KEYS.has(name)) continue
    out[key] = value
  }
  if (privateTempDir !== undefined) {
    out.TMP = privateTempDir
    out.TEMP = privateTempDir
  }
  return out
}

/**
 * Encode an environment as MXC's `KEY=VALUE` array. Entries are sorted so a
 * printed or logged request is byte-stable and diffs read as real changes.
 * @param env - the child environment map.
 * @returns the sorted `KEY=VALUE` entries.
 */
export function environmentEntries(env) {
  return Object.entries(env)
    .filter(([key]) => key.length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
}

/** Deduplicate a path list while dropping empties. */
function uniquePaths(paths) {
  return [...new Set(paths.filter(path => typeof path === 'string' && path.length > 0))]
}

/**
 * The network posture MXC applies. The sandbox seam's modes govern file effects
 * only, so the default keeps the network exactly as unconfined, and an operator
 * who wants MXC's stronger posture asks for `deny`.
 * @param posture - `allow` or `deny`.
 * @returns the directional posture MXC requires explicitly (omission would mean deny).
 */
function networkPolicy(posture) {
  if (posture === 'deny') return { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } }
  return { egress: { default: 'allow' }, ingress: { default: 'allow', hostLoopback: 'allow' } }
}

/**
 * Build the complete MXC request for one confined execution.
 * @param options - the resolved policy, the runtime facts only the runner
 *   knows, and the normalized operator configuration.
 * @param options.config - the normalized plugin configuration.
 * @param options.mode - the confined file-effect mode.
 * @param options.workspaceRoot - the canonical `workspace-write` boundary.
 * @param options.privateTempDir - the granted private temp directory under
 *   `workspace-write`; absent under `read-only`, where nothing is writable.
 * @param options.commandLine - the quoted command line for the wrapped argv.
 * @param options.cwd - the working directory the wrapped command runs in.
 * @param options.env - the child environment map (see {@link childEnvironment}).
 * @param options.containerId - the derived container id.
 * @returns the request document MXC consumes.
 */
export function buildMxcRequest(options) {
  const { config, mode, workspaceRoot, privateTempDir, commandLine, cwd, env, containerId } = options
  // Both confined modes read the workspace: MXC's AppContainer tiers have no
  // ambient read access, so a read the mode does not govern must still be
  // granted explicitly or ordinary commands (git, a compiler, the shell itself)
  // fail on their own files.
  const readonlyPaths = mode === 'workspace-write'
    ? uniquePaths(config.readOnlyRoots)
    : uniquePaths([workspaceRoot, ...config.readOnlyRoots])
  const request = {
    version: MXC_CONTRACT_VERSION,
    containment: config.containment,
    containerId,
    process: {
      commandLine,
      cwd,
      env: environmentEntries(env),
      inheritDefaultEnv: config.environment === 'child+profile',
    },
    filesystem: {
      readwritePaths: mode === 'workspace-write' ? uniquePaths([workspaceRoot, privateTempDir]) : [],
      readonlyPaths,
      deniedPaths: uniquePaths(config.deniedPaths),
    },
    network: networkPolicy(config.network),
    lifecycle: {
      destroyOnExit: true,
      // The per-call model: ACEs MXC wrote for this request are revoked when it
      // ends, so no standing host state outlives the command.
      preservePolicy: !config.clearPolicyOnExit,
    },
    fallback: { allowDaclMutation: config.allowDaclMutation },
  }
  if (config.containment === 'processcontainer' && config.denialReport !== undefined) {
    // `block` records while it denies; `allow` would record and permit, which is
    // a diagnosis mode rather than a boundary.
    const captureDenials = { mode: 'block', outputPath: config.denialReport }
    if (config.retainEtl) captureDenials.retainEtl = true
    request.processContainer = { captureDenials }
  }
  return request
}
