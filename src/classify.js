/**
 * The MXC backend's reported facts: enforcement completeness, its denial
 * dialect, and its structured runner-failure evidence.
 *
 * These are the facts a confined consumer (dsh-bash-sandbox,
 * dsh-pwsh-sandbox) uses to tell three outcomes apart: the command ran and was
 * denied by policy, the command ran and failed on its own, and the sandbox
 * itself never ran the command. The last case must surface as
 * `SANDBOX_UNAVAILABLE`, never as an ordinary task failure.
 *
 * @module dsh-sandbox-windows-mxc/classify
 */

/** The runner's fatal-diagnostic prefix; every runner-side failure prints it. */
export const RUNNER_SIGNATURE = 'mxc-sandbox-run'

/** The exit status the runner uses for its own failures (mirrors the shipped windows-acl rung). */
export const RUNNER_FAILURE_EXIT = 127

/** The subprocess-seam marker whose presence this runner refuses (see the README's limits). */
export const SUBPROCESS_CONTROL_MARKER = 'DSH_SUBPROCESS_CONTROL'

/**
 * How completely this backend governs the mode's promised file effects.
 *
 * Always `partial`, for reasons the provider cannot remove: NTFS hard links
 * alias one file object across paths, so a granted workspace file still has an
 * address outside the granted root; the AppContainer tiers cannot open an
 * object whose DACL names another sandbox's package SID, which makes a tree
 * stamped by such a tool unreadable to the confined child; the selected
 * isolation tier is host-dependent (a host with MXC's base-container tier
 * keeps the caller's ambient reads instead of confining them); and
 * `processContainer.captureDenials.mode: allow`, when an operator enables it,
 * records denials while permitting them.
 */
export const ENFORCEMENT = 'partial'

/**
 * The denial dialect MXC's contained children speak — the case-insensitive
 * stderr substrings a denied file effect produces. Windows denies through
 * `ERROR_ACCESS_DENIED`, which each runtime spells for itself: `cmd` prints
 * "Access is denied.", PowerShell and .NET print "Access to the path '…' is
 * denied.", and Node reports EACCES/EPERM as "permission denied" and
 * "operation not permitted". The set matches the shipped windows-acl rung, so a
 * consumer sees one Windows dialect either way.
 */
export const DENIAL_SIGNATURES = Object.freeze([
  'access is denied',
  'access to the path',
  'permission denied',
  'operation not permitted',
])

/**
 * Structured runner-failure evidence: the runner's own signature, gated on its
 * own exit status so a confined command that merely prints the prefix is never
 * misread as "the command did not run".
 */
export const RUNNER_FAILURE_RULES = Object.freeze([
  Object.freeze({
    allowedExitCodes: Object.freeze([RUNNER_FAILURE_EXIT]),
    fatalSignatures: Object.freeze([RUNNER_SIGNATURE + ': ']),
  }),
])

/** MXC's closed wire-error code set (`ErrorCode`): the marker of MXC's own refusal. */
export const MXC_ERROR_CODES = Object.freeze([
  'malformed_request',
  'unsupported_containment',
  'unsupported_phase',
  'backend_unavailable',
  'malformed_id',
  'stale_id',
  'not_provisioned',
  'not_started',
  'already_started',
  'already_stopped',
  'policy_validation',
  'backend_error',
])

/** How much of the child's stderr tail is retained for envelope detection. */
const TAIL_LIMIT = 8 * 1024

/**
 * Retain a bounded tail of a stream, so envelope detection can read the last
 * line without holding an unbounded command's whole stderr.
 * @param current - the retained tail so far.
 * @param chunk - the next chunk of text.
 * @returns the new tail, at most 8 KiB of characters.
 */
export function appendTail(current, chunk) {
  const combined = current + chunk
  return combined.length <= TAIL_LIMIT ? combined : combined.slice(combined.length - TAIL_LIMIT)
}

/**
 * The last non-empty line of a text.
 * @param text - the text to read.
 * @returns the trimmed final line, or undefined when every line is blank.
 */
export function finalLine(text) {
  const lines = text.split(/\r?\n/u).filter(line => line.trim().length > 0)
  return lines.length === 0 ? undefined : lines[lines.length - 1].trim()
}

/** One parsed JSON object, or undefined when the text is not one. */
function parseJsonObject(text) {
  if (!text.startsWith('{')) return undefined
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Recognise MXC's own error envelope on the LAST non-empty stderr line.
 *
 * MXC reports a dispatch failure (unsupported containment, an unusable backend,
 * a rejected policy) as a JSON error envelope emitted after whatever the script
 * already printed, so the envelope is the final line. Requiring the final line
 * AND a known error code keeps a command that merely prints JSON — or prints
 * `{"error":"backend_error"}` mid-stream — from being misclassified as a
 * sandbox failure.
 * @param stderrTail - the child's retained stderr tail.
 * @returns the envelope's error code, or undefined when the tail ends in
 *   ordinary command output.
 */
export function mxcErrorEnvelopeCode(stderrTail) {
  const last = finalLine(stderrTail)
  if (last === undefined) return undefined
  const envelope = parseJsonObject(last)
  if (envelope === undefined || !Object.hasOwn(envelope, 'error')) return undefined
  const error = envelope.error
  const code = typeof error === 'string' ? error : (error !== null && typeof error === 'object' ? error.code : undefined)
  return typeof code === 'string' && MXC_ERROR_CODES.includes(code) ? code : undefined
}

/**
 * The Windows variables a MXC ProcessContainer launch requires when the
 * request supplies an explicit environment: MXC refuses an `env` array that
 * lacks them. They are reported so the runner can name the operator's fix
 * (`environment: child+profile`) instead of surfacing an opaque MXC refusal.
 * @param env - the environment that would be supplied to the child.
 * @returns the missing required names, empty when the environment is usable.
 */
export function missingLaunchRequirements(env) {
  const names = new Set(Object.keys(env).map(name => name.toUpperCase()))
  return ['SYSTEMROOT', 'LOCALAPPDATA'].filter(name => !names.has(name))
}
