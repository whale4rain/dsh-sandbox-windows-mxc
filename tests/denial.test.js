import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCESS_DENIED,
  LOCALIZATION_QUERY,
  STATIC_SIGNATURES,
  denialDialect,
  localizedAccessDenied,
} from '../src/denial.js'

/**
 * The bytes a zh-CN host's console code page (936) produces for its denial
 * wording, followed by the ASCII code-point line — captured from this project's
 * own acceptance run, so the fixture is the transport, not a paraphrase.
 */
const CHINESE_MESSAGE = String.fromCodePoint(0x62d2, 0x7edd, 0x8bbf, 0x95ee, 0x3002)
const HOST_BYTES = Buffer.from('bedcbef8b7c3cecaa1a30d0a', 'hex')

/** Encode text the way the ASCII code-point line transports it. */
function asCodePoints(text) {
  return [...text].map(character => character.codePointAt(0)).join(' ')
}

/** A spawn stub answering with the given stdout and status, recording its call. */
function stub(stdout, status = 0) {
  const spawn = (command, args, options) => {
    spawn.last = { command, args, options, encoding: options?.encoding }
    return { status, stdout }
  }
  return spawn
}

/** The two-line answer a zh-CN host gives. */
function chineseHost() {
  return Buffer.concat([HOST_BYTES, Buffer.from(asCodePoints(CHINESE_MESSAGE) + String.fromCharCode(13, 10), 'utf8')])
}

test('the host wording is read in both readings a consumer can meet', () => {
  const spawn = stub(chineseHost())
  const signatures = localizedAccessDenied({ spawn })
  assert.equal(signatures.length, 2)
  // The true message, for a child that writes UTF-8…
  assert.equal(signatures[0], CHINESE_MESSAGE)
  assert.match(signatures[0], /[\u4e00-\u9fff]/u)
  // …and the byte-level reading a UTF-8-decoding consumer actually sees, which
  // is the only form that can match a cmd.exe child on this code page.
  assert.equal(signatures[1], HOST_BYTES.toString('utf8').trim())
  assert.notEqual(signatures[0], signatures[1])
  // The bytes are captured undecoded: decoding them in the child would destroy
  // the second reading.
  assert.equal(spawn.last.encoding, undefined)
  assert.equal(spawn.last.command, 'powershell.exe')
  assert.ok(spawn.last.options.timeout > 0, 'the query is bounded')
  assert.ok(LOCALIZATION_QUERY.includes(String(ACCESS_DENIED)))
  assert.equal(ACCESS_DENIED, 5)
})

test('an ASCII host yields one signature, because both readings agree', () => {
  const english = 'Access is denied.'
  const combined = Buffer.from(english + String.fromCharCode(13, 10) + asCodePoints(english), 'utf8')
  assert.deepEqual(localizedAccessDenied({ spawn: stub(combined) }), [english])
  // A UTF-8 console host behaves the same way: bytes already decode to the text.
  const utf8 = Buffer.from(CHINESE_MESSAGE + String.fromCharCode(10) + asCodePoints(CHINESE_MESSAGE), 'utf8')
  assert.deepEqual(localizedAccessDenied({ spawn: stub(utf8) }), [CHINESE_MESSAGE])
})

test('every failure path degrades to the static dialect', () => {
  const cases = [
    ['non-zero exit', stub(chineseHost(), 1)],
    ['empty buffer', stub(Buffer.alloc(0))],
    ['no code-point line', stub(HOST_BYTES)],
    ['blank stdout', stub(Buffer.from(String.fromCharCode(10) + String.fromCharCode(10)))],
    ['out-of-range point', stub(Buffer.from('msg' + String.fromCharCode(10) + '1114112', 'utf8'))],
    ['non-numeric point line', stub(Buffer.from('msg' + String.fromCharCode(10) + 'not points', 'utf8'))],
    ['message too long', stub(Buffer.from('x'.repeat(200) + String.fromCharCode(10) + asCodePoints('y'.repeat(200)), 'utf8'))],
    ['null stdout', { status: 0, stdout: null }],
    ['spawn throws', () => { throw new Error('EPERM') }],
    ['spawn returns nothing', () => undefined],
  ]
  for (const [label, spawn] of cases) {
    assert.deepEqual(localizedAccessDenied({ spawn: typeof spawn === 'function' ? spawn : stub(spawn.stdout, spawn.status) }), [], label)
    assert.deepEqual(
      denialDialect({ spawn: typeof spawn === 'function' ? spawn : stub(spawn.stdout, spawn.status) }),
      [...STATIC_SIGNATURES],
      label,
    )
  }
})

test('operator extras are appended and deduplicated', () => {
  const dialect = denialDialect({
    spawn: stub(chineseHost()),
    extra: ['拒绝访问', '拒绝访问', '', 'access is denied'],
  })
  assert.ok(dialect.includes('拒绝访问'))
  assert.equal(dialect.filter(entry => entry === '拒绝访问').length, 1)
  assert.equal(dialect.filter(entry => entry === 'access is denied').length, 1)
  assert.equal(dialect.length, STATIC_SIGNATURES.length + 3)
})

test('the dialect never claims a denial the backend cannot produce', () => {
  // Exactly the host's two readings; nothing is invented for other locales.
  assert.equal(denialDialect({ spawn: stub(chineseHost()) }).length, STATIC_SIGNATURES.length + 2)
  assert.equal(denialDialect({ spawn: stub(Buffer.from('x' + String.fromCharCode(10) + '120 + 10', 'utf8')) }).length, STATIC_SIGNATURES.length)
})
