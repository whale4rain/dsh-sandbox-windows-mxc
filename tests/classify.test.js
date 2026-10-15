import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DENIAL_SIGNATURES,
  ENFORCEMENT,
  MXC_ERROR_CODES,
  RUNNER_FAILURE_EXIT,
  RUNNER_FAILURE_RULES,
  RUNNER_SIGNATURE,
  SUBPROCESS_CONTROL_MARKER,
  appendTail,
  finalLine,
  missingLaunchRequirements,
  mxcErrorEnvelopeCode,
} from '../src/classify.js'

const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)

test('enforcement is reported partial with the documented boundaries', () => {
  assert.equal(ENFORCEMENT, 'partial')
})

test('the denial dialect matches the shipped Windows rung', () => {
  assert.deepEqual([...DENIAL_SIGNATURES],
    ['access is denied', 'access to the path', 'permission denied', 'operation not permitted'])
})

test('runner-failure evidence is gated on the runner exit status', () => {
  assert.deepEqual([...RUNNER_FAILURE_RULES], [{ allowedExitCodes: [RUNNER_FAILURE_EXIT], fatalSignatures: [RUNNER_SIGNATURE + ': '] }])
  assert.equal(RUNNER_FAILURE_EXIT, 127)
  assert.equal(SUBPROCESS_CONTROL_MARKER, 'DSH_SUBPROCESS_CONTROL')
  // A confined command that merely prints the prefix with another status is not runner failure.
  assert.ok(!RUNNER_FAILURE_RULES[0].allowedExitCodes.includes(0))
})

test('an MXC error envelope is recognised only as the final stderr line', () => {
  assert.equal(mxcErrorEnvelopeCode('hello' + NL + '{"error":{"code":"backend_unavailable","message":"x"}}' + NL), 'backend_unavailable')
  assert.equal(mxcErrorEnvelopeCode('{"error":"policy_validation"}' + NL), 'policy_validation')
  assert.equal(mxcErrorEnvelopeCode('{"error":{"code":"malformed_request"}}' + CR + NL), 'malformed_request')
  // A command that prints an error envelope and keeps going is ordinary output.
  assert.equal(mxcErrorEnvelopeCode('{"error":{"code":"backend_error"}}' + NL + 'more output' + NL), undefined)
  // Unknown or absent codes stay unclassified.
  assert.equal(mxcErrorEnvelopeCode('{"error":{"code":"nope"}}' + NL), undefined)
  assert.equal(mxcErrorEnvelopeCode('{"warning":"x"}' + NL), undefined)
  assert.equal(mxcErrorEnvelopeCode('plain failure' + NL + NL), undefined)
  assert.equal(mxcErrorEnvelopeCode(''), undefined)
  assert.equal(mxcErrorEnvelopeCode('{not json}'), undefined)
  assert.ok(MXC_ERROR_CODES.includes('backend_unavailable') && !MXC_ERROR_CODES.includes('nope'))
})

test('the stderr tail stays bounded', () => {
  const long = 'x'.repeat(9000)
  const tail = appendTail(long, 'tail')
  assert.equal(tail.length, 8192)
  assert.ok(tail.endsWith('tail'))
  assert.equal(appendTail('short', 'er'), 'shorter')
})

test('the final line ignores blank trailing lines', () => {
  assert.equal(finalLine('a' + NL + NL), 'a')
  assert.equal(finalLine(NL + '  b  '), 'b')
  assert.equal(finalLine(NL + NL), undefined)
})

test('launch requirements are matched case-insensitively', () => {
  assert.deepEqual(missingLaunchRequirements({}), ['SYSTEMROOT', 'LOCALAPPDATA'])
  assert.deepEqual(missingLaunchRequirements({ SystemRoot: 'x' }), ['LOCALAPPDATA'])
  assert.deepEqual(missingLaunchRequirements({ SYSTEMROOT: 'x', localappdata: 'y' }), [])
})
