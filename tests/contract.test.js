import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DRY_RUN_FLAG, SUPPORTED, UNPROBED, lastNonEmptyLine, verifyContract } from '../src/contract.js'

const EXEC = join('C:', 'mxc', 'wxc-exec.exe')
const REQUEST = { version: '1.0.0', containment: 'processcontainer', process: { commandLine: 'cmd /c exit 0' } }

/** A spawn stub that records its call and answers with the given status/streams. */
function stub({ status = 0, stdout = '', stderr = '' } = {}) {
  const spawn = (command, args, options) => {
    spawn.last = { command, args, options }
    return { status, stdout, stderr }
  }
  return spawn
}

test('an accepted request is reported supported', () => {
  const spawn = stub()
  assert.equal(verifyContract({ execPath: EXEC, request: REQUEST, spawn }), SUPPORTED)
  assert.equal(spawn.last.command, EXEC)
  assert.equal(spawn.last.args[0], DRY_RUN_FLAG)
  assert.equal(spawn.last.options.encoding, 'utf8')
  assert.ok(spawn.last.options.timeout > 0, 'the probe is bounded')
  // The request is handed over as a file, which is the executor's own argument
  // contract; the scratch directory does not outlive the probe.
  assert.equal(existsSync(spawn.last.args[1]), false, 'the request file is removed with its scratch directory')
})

test('the probed file really carries the request under test', () => {
  let seen
  const spawn = (command, args) => {
    seen = JSON.parse(readFileSync(args[1], 'utf8'))
    return { status: 0, stdout: '', stderr: '' }
  }
  assert.equal(verifyContract({ execPath: EXEC, request: REQUEST, spawn }), SUPPORTED)
  assert.deepEqual(seen, REQUEST)
})

test('a refusal carries MXC own message, taken from the last line', () => {
  const stderr = 'Request error' + String.fromCharCode(10)
    + "Configuration parse error: Config schema version '1.0.0' is newer than supported (supported: >=0.6, <=0.9)"
    + String.fromCharCode(10)
  const verdict = verifyContract({ execPath: EXEC, request: REQUEST, spawn: stub({ status: 1, stderr }) })
  assert.equal(verdict.detail, "Configuration parse error: Config schema version '1.0.0' is newer than supported (supported: >=0.6, <=0.9)")
})

test('a refusal that names only stdout is still reported', () => {
  const verdict = verifyContract({ execPath: EXEC, request: REQUEST, spawn: stub({ status: 3, stdout: 'denied: bad policy' }) })
  assert.equal(verdict.detail, 'denied: bad policy')
  const silent = verifyContract({ execPath: EXEC, request: REQUEST, spawn: stub({ status: 3 }) })
  assert.equal(silent.detail, 'the executor refused the request')
})

test('an executor without the flag yields no verdict about the request', () => {
  const cases = [
    "error: unexpected argument '--dry-run' found",
    'error: unrecognized option --dry-run',
    'error: unknown option --dry-run',
    'usage: executor [invalid option]',
  ]
  for (const text of cases) {
    assert.equal(verifyContract({ execPath: EXEC, request: REQUEST, spawn: stub({ status: 2, stderr: text }) }), UNPROBED, text)
    assert.equal(verifyContract({ execPath: EXEC, request: REQUEST, spawn: stub({ status: 2, stdout: text }) }), UNPROBED, text)
  }
})

test('a spawn failure is reported as a refusal, not as support', () => {
  const verdict = verifyContract({ execPath: EXEC, request: REQUEST, spawn: () => { throw new Error('EPERM: not executable') } })
  assert.equal(verdict.detail, 'EPERM: not executable')
})

test('the probe never leaves its scratch directory behind', () => {
  const names = () => readdirSync(tmpdir())
  const before = new Set(names())
  verifyContract({ execPath: EXEC, request: REQUEST, spawn: stub({ status: 1, stderr: 'nope' }) })
  const leaked = names().filter(name => !before.has(name) && name.startsWith('dsh-mxc-verify-'))
  assert.deepEqual(leaked, [])
})

test('the final line helper ignores blank trailing lines', () => {
  assert.equal(lastNonEmptyLine('a' + String.fromCharCode(10) + String.fromCharCode(10)), 'a')
  assert.equal(lastNonEmptyLine(String.fromCharCode(10) + '  b  '), 'b')
  assert.equal(lastNonEmptyLine('   '), undefined)
  assert.equal(lastNonEmptyLine(undefined), undefined)
})
