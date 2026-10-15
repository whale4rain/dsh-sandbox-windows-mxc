/**
 * The denial dialect, derived from the host rather than guessed.
 *
 * A denied file effect speaks through the OS: the contained child prints
 * whatever Windows' own message table says for `ERROR_ACCESS_DENIED`, in the
 * host's UI language and console code page. Two facts follow, both verified by
 * running a denied write through MXC on a zh-CN host:
 *
 * - the wording is not English (that host prints its Chinese message), so a
 *   dialect listing only English wordings turns a policy denial into an
 *   ordinary task failure there — exactly the distinction the seam requires
 *   consumers to keep;
 * - the bytes are the child's console code page, while the harness decodes a
 *   confined child's stderr as UTF-8, so what the consumer MATCHES against is
 *   the mis-decoded reading of those bytes, not the message itself.
 *
 * Node cannot read the message in process on Windows
 * (`util.getSystemErrorMessage` answers "Unknown system error -13" there), so
 * the host's message table is queried once through PowerShell, in one call that
 * emits both readings: the message as the host writes it (so the byte-level
 * reading the harness sees is reproducible) and the same message as decimal
 * code points over ASCII (so no console encoding can corrupt the true text).
 * Both readings become signatures. Every failure path degrades to the static
 * English wordings: a sandbox that cannot describe its dialect must still
 * report one.
 *
 * @module dsh-sandbox-windows-mxc/denial
 */

import { spawnSync } from 'node:child_process'

/** `ERROR_ACCESS_DENIED`: the Windows code a denied file effect carries. */
export const ACCESS_DENIED = 5

/** The message-table lookup both readings start from. */
const MESSAGE = '[ComponentModel.Win32Exception]::new(' + ACCESS_DENIED + ').Message'

/**
 * The one-shot query: the raw message first (whatever the host's console
 * encoding produces), then its code points as ASCII digits. The digit line is
 * unambiguously parseable whatever the code page did to the first line.
 */
export const LOCALIZATION_QUERY = MESSAGE + '; [string]::Join(" ", [int[]][char[]](' + MESSAGE + '))'

/** How long the one-time localization query may take. */
const QUERY_TIMEOUT_MS = 5_000

/** A system message longer than this is not a denial wording. */
const MAX_SIGNATURE_LENGTH = 64

/** Whether a candidate is a usable single-line signature. */
function isSignature(text) {
  return typeof text === 'string'
    && text.length > 0
    && text.length <= MAX_SIGNATURE_LENGTH
    && !/[\r\n]/u.test(text)
}

/** Decode the ASCII code-point line back into the message. */
function decodeCodePoints(line) {
  const fields = String(line ?? '').trim().split(/\s+/u).filter(field => field.length > 0)
  if (fields.length === 0) return undefined
  const points = fields.map(field => Number(field))
  if (points.some(point => !Number.isInteger(point) || point < 0 || point > 0x10ffff)) return undefined
  return String.fromCodePoint(...points)
}

/**
 * Read the host's wording for `ERROR_ACCESS_DENIED` in both readings.
 *
 * The bytes are captured undecoded, because the second reading IS the
 * mis-decode: `Buffer.prototype.toString('utf8')` on the host's own bytes is
 * exactly what a UTF-8-decoding consumer observes.
 * @param options - resolution inputs; both are injectable for tests.
 * @param options.spawn - the synchronous spawn used for the query.
 * @param options.powershell - the executable to query the message table with.
 * @returns the usable signatures, empty when the host cannot be asked.
 */
export function localizedAccessDenied(options = {}) {
  const { spawn = spawnSync, powershell = 'powershell.exe' } = options
  try {
    const result = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', LOCALIZATION_QUERY], {
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    })
    if (result?.status !== 0) return []
    const stdout = result.stdout
    if (stdout === undefined || stdout === null) return []
    const decoded = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout)
    const lines = decoded.split(/\r?\n/u).filter(line => line.length > 0)
    if (lines.length < 2) return []
    const trueText = decodeCodePoints(lines[lines.length - 1])
    if (trueText === undefined) return []
    const message = trueText.trim()
    if (!isSignature(message)) return []
    // The byte-level reading: what the host wrote, run through a UTF-8 decoder.
    // On an ASCII or UTF-8-console host this equals the message itself and
    // deduplicates away; on an OEM-code-page host it is the only reading the
    // consumer can see.
    const byteReading = lines[0]
    return isSignature(byteReading) && byteReading !== message ? [message, byteReading] : [message]
  } catch {
    return []
  }
}

/**
 * The English wordings, which stay in the dialect regardless of host language:
 * the harness's own components (Node's `EACCES`/`EPERM` text) and .NET's English
 * resource strings appear independently of the host UI language.
 */
export const STATIC_SIGNATURES = Object.freeze([
  'access is denied',
  'access to the path',
  'permission denied',
  'operation not permitted',
])

/**
 * The complete denial dialect for one provider: the static English wordings,
 * the host's own wording in both readings when they can be read, and any extra
 * substrings the operator supplied.
 * @param options - the operator's extra signatures and the query inputs.
 * @param options.extra - extra case-insensitive substrings from the configuration.
 * @param options.spawn - the synchronous spawn used for the localization query.
 * @param options.powershell - the executable to query the message table with.
 * @returns the deduplicated dialect, static entries first.
 */
export function denialDialect(options = {}) {
  const { extra = [], ...query } = options
  const dialect = [...STATIC_SIGNATURES, ...localizedAccessDenied(query), ...extra]
  return [...new Set(dialect.filter(isSignature))]
}
