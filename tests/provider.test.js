import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import MxcSandboxProvider from '../index.js'
import { parseRunnerArgv } from '../src/argv.js'

const EXEC = join('C:', 'mxc', 'wxc-exec.exe')
const RUNNER = join('C:', 'pkg', 'runner.js')
const WORKSPACE = process.cwd()

/** Build a provider over its own context, with working test hooks. */
function mounted(config = {}, internals = {}) {
  const instance = new MxcSandboxProvider(new Context(), config)
  instance.internals = { platform: 'win32', execPath: EXEC, runnerEntry: RUNNER, ...internals }
  return instance
}

test('the provider is a sandbox-seam occupant', () => {
  assert.ok(mounted() instanceof SandboxProvider)
})

test('workspace-write wraps the exact argv in the runner dialect', async () => {
  const confined = await mounted().confine(['pwsh', '-NoProfile', '-Command', 'Get-Location'], {
    mode: 'workspace-write',
    workspaceRoot: WORKSPACE,
    sessionId: 'session-1',
  })
  assert.equal(confined.argv[0], process.execPath)
  assert.equal(confined.argv[1], RUNNER)
  assert.deepEqual(confined.argv.slice(-4), ['pwsh', '-NoProfile', '-Command', 'Get-Location'])
  const facts = parseRunnerArgv(confined.argv.slice(2))
  assert.equal(facts.mode, 'workspace-write')
  assert.equal(facts.execPath, EXEC)
  assert.equal(facts.tempRoot, tmpdir())
  assert.equal(facts.workspaceRoot, WORKSPACE)
  assert.equal(confined.enforcement, 'partial')
  assert.equal(confined.denialSignatures.length, 4)
  assert.deepEqual(confined.runnerFailureRules, [{ allowedExitCodes: [127], fatalSignatures: ['mxc-sandbox-run: '] }])
})

test('read-only names no temp root and no writable grant', async () => {
  const confined = await mounted().confine(['cmd', '/c', 'dir'], { mode: 'read-only', workspaceRoot: WORKSPACE })
  const facts = parseRunnerArgv(confined.argv.slice(2))
  assert.equal(facts.mode, 'read-only')
  assert.equal(facts.tempRoot, undefined)
  assert.ok(!confined.argv.includes('--temp'))
})

test('operator configuration reaches the runner argv', async () => {
  const confined = await mounted({
    readOnlyRoots: [join('C:', 'Tools')],
    deniedPaths: [join('C:', 'secret')],
    network: 'deny',
    environment: 'child+profile',
    allowDaclMutation: false,
    clearPolicyOnExit: false,
    denialReport: join('C:', 'denials.json'),
    retainEtl: true,
    mxcArgs: ['--debug'],
  }).confine(['cmd'], { mode: 'workspace-write', workspaceRoot: WORKSPACE })
  const facts = parseRunnerArgv(confined.argv.slice(2))
  assert.deepEqual(facts.readOnlyRoots, [join('C:', 'Tools')])
  assert.deepEqual(facts.deniedPaths, [join('C:', 'secret')])
  assert.equal(facts.network, 'deny')
  assert.equal(facts.environment, 'child+profile')
  assert.equal(facts.daclMutation, 'deny')
  assert.equal(facts.preservePolicy, true)
  assert.equal(facts.denialReport, join('C:', 'denials.json'))
  assert.equal(facts.retainEtl, true)
  assert.deepEqual(facts.mxcArgs, ['--debug'])
})

test('the container id distinguishes sessions over one workspace', async () => {
  const instance = mounted()
  const first = await instance.confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE, sessionId: 'a' })
  const second = await instance.confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE, sessionId: 'b' })
  const again = await instance.confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE, sessionId: 'a' })
  const id = argv => parseRunnerArgv(argv.slice(2)).containerId
  assert.equal(id(first.argv), id(again.argv))
  assert.notEqual(id(first.argv), id(second.argv))
  assert.match(id(first.argv), /^dsh-[0-9a-f]{24}$/)
})

test('a non-Windows host fails closed with SANDBOX_UNAVAILABLE', async () => {
  await assert.rejects(
    mounted({}, { platform: 'linux' }).confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE }),
    error => error instanceof SandboxUnavailableError && error.code === SANDBOX_UNAVAILABLE && /Windows only/.test(error.message),
  )
})

test('an unusable MXC executor fails closed rather than running unconfined', async () => {
  await assert.rejects(
    new MxcSandboxProvider(new Context(), { execPath: join('C:', 'nope', 'wxc-exec.exe') })
      .confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE }),
    error => error instanceof SandboxUnavailableError && error.code === SANDBOX_UNAVAILABLE && /execPath does not exist/.test(error.message),
  )
  const unresolvable = new MxcSandboxProvider(new Context(), {})
  unresolvable.internals = { platform: 'win32' }
  await assert.rejects(
    unresolvable.confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE }),
    error => error instanceof SandboxUnavailableError
      && error.code === SANDBOX_UNAVAILABLE
      && error.message.includes('install it, set execPath'),
  )
})

test('cancellation and caller mistakes are refused before any spawn', async () => {
  const reason = new Error('stop')
  await assert.rejects(
    mounted().confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE }, AbortSignal.abort(reason)),
    error => error === reason,
  )
  await assert.rejects(mounted().confine(['cmd'], { mode: 'danger-full-access', workspaceRoot: WORKSPACE }),
    /accepts the confined modes read-only and workspace-write/)
  await assert.rejects(mounted().confine(['cmd'], { mode: 'process' }), /accepts the confined modes/)
  await assert.rejects(mounted().confine([], { mode: 'read-only', workspaceRoot: WORKSPACE }),
    /requires the non-empty argv/)
  await assert.rejects(mounted().confine(['cmd'], { mode: 'read-only', workspaceRoot: '' }),
    /must carry a non-empty workspaceRoot/)
})

test('the runner entry is resolved once and reused', async () => {
  const instance = mounted()
  const first = await instance.confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE })
  instance.internals.runnerEntry = join('C:', 'elsewhere', 'runner.js')
  const second = await instance.confine(['cmd'], { mode: 'read-only', workspaceRoot: WORKSPACE })
  assert.equal(first.argv[1], second.argv[1])
  assert.equal(second.argv[1], RUNNER)
})

test('the workspace root is canonicalized once, so a symlinked spelling is not a second policy', async () => {
  const spelling = WORKSPACE + sep + 'src' + sep + '..'
  const facts = parseRunnerArgv((await mounted().confine(['cmd'], { mode: 'read-only', workspaceRoot: spelling })).argv.slice(2))
  assert.equal(facts.workspaceRoot, WORKSPACE)
})
