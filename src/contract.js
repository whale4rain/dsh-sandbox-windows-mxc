/**
 * Contract verification: does the installed MXC executor accept the request
 * shape this plugin sends?
 *
 * MXC validates an exact contract and refuses a request it does not support
 * BEFORE running anything. That refusal is the sandbox failing, not the command
 * failing — but MXC reports it on stderr as ordinary text ("Request error /
 * Configuration parse error: Config schema version '1.0.0' is newer than
 * supported (supported: >=0.6, <=0.9)"), with no exit status reserved for it, so
 * a consumer that only reads exit codes and the runner's own signature cannot
 * tell the two apart.
 *
 * So the question is asked once per provider, up front, the way the shipped
 * local backend functionally probes its runners: the executor is handed the
 * request for an actual call with `--dry-run` (parse and validate, then exit
 * without spawning anything). A refusal becomes a fail-closed
 * `SANDBOX_UNAVAILABLE` naming MXC's own message; acceptance is cached for the
 * provider's lifetime. An executor that does not know `--dry-run` yields no
 * verdict at all — an unknown flag is the probe being unavailable, never
 * evidence against the backend.
 *
 * @module dsh-sandbox-windows-mxc/contract
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The executor flag that validates a request without executing it. */
export const DRY_RUN_FLAG = '--dry-run'

/** How long one verification may take. */
export const VERIFY_TIMEOUT_MS = 10_000

/** The argument parser's own refusal spellings, which mean the flag is unsupported. */
const UNKNOWN_FLAG_PATTERNS = Object.freeze([
  /unexpected argument/iu,
  /unrecognized option/iu,
  /unknown option/iu,
  /invalid option/iu,
])

/** The verdicts a verification can reach. */
export const SUPPORTED = 'supported'

/** The probe could not be run at all (no `--dry-run` on this executor). */
export const UNPROBED = 'unprobed'

/**
 * The last non-empty line of a stream, which is where MXC states its refusal.
 * @param text - the captured stream.
 * @returns the trimmed final line, or undefined when every line is blank.
 */
export function lastNonEmptyLine(text) {
  const lines = String(text ?? '').split(/\r?\n/u).filter(line => line.trim().length > 0)
  return lines.length === 0 ? undefined : lines[lines.length - 1].trim()
}

/**
 * Ask the executor to validate one request.
 * @param options - the executor, the request document, and the spawn.
 * @param options.execPath - the MXC executor to invoke.
 * @param options.request - the request document this call would run under.
 * @param options.spawn - the synchronous spawn, injectable for tests.
 * @returns `'supported'`, `'unprobed'`, or `{ detail }` describing MXC's refusal.
 */
export function verifyContract(options) {
  const { execPath, request, spawn = spawnSync } = options
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mxc-verify-'))
  const path = join(scratch, 'request.json')
  try {
    writeFileSync(path, JSON.stringify(request), 'utf8')
    const result = spawn(execPath, [DRY_RUN_FLAG, path], {
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      windowsHide: true,
    })
    if (result?.status === 0) return SUPPORTED
    const stdout = String(result?.stdout ?? '')
    const stderr = String(result?.stderr ?? '')
    // An unknown flag means this executor has no dry run; that is not a verdict
    // about the request, so the command runs and classifies normally.
    if (UNKNOWN_FLAG_PATTERNS.some(pattern => pattern.test(stdout) || pattern.test(stderr))) return UNPROBED
    return { detail: lastNonEmptyLine(stderr) ?? lastNonEmptyLine(stdout) ?? 'the executor refused the request' }
  } catch (error) {
    // A missing or unstartable executor is the executor's own failure, reported
    // the same way a refused request is.
    return { detail: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
