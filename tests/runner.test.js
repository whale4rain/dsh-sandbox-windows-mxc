import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { RUNNER_FAILURE_EXIT, RUNNER_SIGNATURE } from '../src/classify.js'

const here = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(here, '..', 'runner.js')
const STUB = join(here, 'support', 'stub-executor.js')
const NL = String.fromCharCode(10)

/**
 * Run the runner with the stub standing in for wxc-exec.exe.
 *
 * Every invocation gets its own workspace and temp root, both outside each
 * other, so a case can override either without the runner's boundary guard
 * firing for an unintended reason.
 * @param options - command, environment, and directory overrides.
 * @returns the spawn result, the stub's observation, and the fixture paths.
 */
function runRunner(options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mxc-runner-'))
  const workspace = join(base, 'ws')
  const tempRoot = join(base, 'tmp')
  mkdirSync(workspace)
  mkdirSync(tempRoot)
  const report = join(base, 'report.json')
  const env = {
    ...process.env,
    STUB_REPORT: report,
    STUB_STDOUT: '',
    STUB_STDERR: '',
    STUB_EXIT: '0',
    ...options.env === undefined ? {} : options.env,
  }
  delete env.DSH_SUBPROCESS_CONTROL
  if (options.controlMarker === true) env.DSH_SUBPROCESS_CONTROL = 'pipe'
  const cwd = options.cwd ?? workspace
  const result = spawnSync(process.execPath, [
    RUNNER,
    '--workspace', options.workspace ?? workspace,
    '--mode', options.mode ?? 'workspace-write',
    '--exec', process.execPath,
    ...options.mode === 'read-only' ? [] : ['--temp', options.tempRoot ?? tempRoot],
    '--mxc-arg', STUB,
    ...options.extraArgs ?? [],
    '--', ...(options.argv ?? ['cmd', '/c', 'exit', '0']),
  ], { cwd, env, encoding: 'utf8' })
  const observed = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : undefined
  return { result, observed, base, workspace, tempRoot, cwd }
}

/** Run a case and remove its fixture afterwards. */
function withFixture(options, body) {
  const fixture = runRunner(options)
  try {
    body(fixture)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
}

test('the wrapped command runs under the request the runner built', () => {
  withFixture({ argv: ['pwsh', '-NoProfile', '-Command', 'Write-Output hi'] }, ({ result, observed, cwd }) => {
    assert.equal(result.status, 0, result.stderr)
    assert.ok(observed !== undefined, 'the executor never received a request')
    assert.equal(observed.request.version, '1.0.0')
    assert.equal(observed.request.containment, 'processcontainer')
    assert.equal(observed.request.process.commandLine, 'pwsh -NoProfile -Command "Write-Output hi"')
    assert.equal(observed.request.process.cwd, cwd)
    assert.equal(observed.request.filesystem.deniedPaths.length, 0)
    assert.deepEqual(observed.request.network, {
      egress: { default: 'allow' },
      ingress: { default: 'allow', hostLoopback: 'allow' },
    })
    assert.deepEqual(observed.request.lifecycle, { destroyOnExit: true, preservePolicy: false })
  })
})

test('workspace-write grants the workspace plus a private temp directory that is cleaned up', () => {
  withFixture({}, ({ result, observed, tempRoot, workspace }) => {
    assert.equal(result.status, 0, result.stderr)
    const [grantedWorkspace, grantedTemp] = observed.request.filesystem.readwritePaths
    assert.equal(grantedWorkspace, workspace)
    assert.equal(dirname(grantedTemp), tempRoot)
    assert.match(grantedTemp, /dsh-mxc-/)
    // The wrapped command's environment points its temp entries at the granted
    // directory, and carries no copy of the harness's own launch marker.
    const entries = observed.request.process.env
    assert.ok(entries.includes('TMP=' + grantedTemp), String(entries))
    assert.ok(entries.includes('TEMP=' + grantedTemp), String(entries))
    assert.ok(!entries.some(entry => entry.toUpperCase().startsWith('DSH_SUBPROCESS_CONTROL=')), String(entries))
    // Both the private temp directory and the request scratch directory are removed.
    assert.deepEqual(readdirSync(tempRoot), [])
    assert.equal(existsSync(dirname(observed.configPath)), false)
  })
})

test('read-only grants nothing writable and leaves the ambient temp entries alone', () => {
  withFixture({ mode: 'read-only' }, ({ result, observed }) => {
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(observed.request.filesystem.readwritePaths, [])
    assert.equal(observed.request.filesystem.readonlyPaths.length, 1)
    assert.equal(observed.environment.TMP, process.env.TMP)
  })
})

test('the wrapped command output is relayed verbatim and its exit status mirrored', () => {
  withFixture({
    argv: ['cmd'],
    env: { STUB_STDOUT: 'out line' + NL, STUB_STDERR: 'err line' + NL, STUB_EXIT: '7' },
  }, ({ result }) => {
    assert.equal(result.status, 7)
    assert.equal(result.stdout, 'out line' + NL)
    assert.equal(result.stderr, 'err line' + NL)
  })
})

test('an MXC refusal becomes the runner-failure signature, never a task failure', () => {
  const envelope = JSON.stringify({ error: { code: 'backend_unavailable', message: 'no tier' } })
  withFixture({ env: { STUB_STDERR: envelope + NL, STUB_EXIT: '1' } }, ({ result }) => {
    assert.equal(result.status, RUNNER_FAILURE_EXIT)
    assert.ok(result.stderr.includes(RUNNER_SIGNATURE + ': MXC refused the request (backend_unavailable)'), result.stderr)
    assert.ok(result.stderr.indexOf(envelope) >= 0, 'the raw envelope is preserved for the operator')
  })
})

test('an ordinary non-zero exit is not misread as a sandbox failure', () => {
  const lookalike = 'mxc-sandbox-run: not really' + NL
  withFixture({ env: { STUB_STDERR: lookalike, STUB_EXIT: '3' } }, ({ result }) => {
    assert.equal(result.status, 3)
    assert.equal(result.stderr, lookalike)
  })
})

test('impossible runner arguments fail closed with the usage text', () => {
  withFixture({}, ({ base }) => {
    const missing = runRunner({ workspace: join(base, 'absent'), tempRoot: join(base, 'tmp2') })
    try {
      assert.equal(missing.result.status, RUNNER_FAILURE_EXIT)
      assert.ok(missing.result.stderr.includes(RUNNER_SIGNATURE + ': --workspace is not an existing directory:'), missing.result.stderr)
    } finally {
      rmSync(missing.base, { recursive: true, force: true })
    }
  })
  // A temp root inside the workspace would make the two grants indistinguishable.
  withFixture({ tempRoot: undefined }, () => {})
  const nested = (() => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-mxc-nested-'))
    const workspace = join(base, 'ws')
    mkdirSync(workspace)
    mkdirSync(join(workspace, 'tmp'))
    const result = spawnSync(process.execPath, [
      RUNNER, '--workspace', workspace, '--mode', 'workspace-write', '--exec', process.execPath,
      '--temp', join(workspace, 'tmp'), '--', 'cmd',
    ], { cwd: workspace, env: process.env, encoding: 'utf8' })
    rmSync(base, { recursive: true, force: true })
    return result
  })()
  assert.equal(nested.status, RUNNER_FAILURE_EXIT)
  assert.ok(nested.stderr.includes('must not be the workspace or inside it'), nested.stderr)
})

test('the subprocess control channel is refused rather than silently dropped', () => {
  withFixture({ controlMarker: true }, ({ result }) => {
    assert.equal(result.status, RUNNER_FAILURE_EXIT)
    assert.ok(result.stderr.includes('the DSH subprocess control channel is not forwardable through MXC'), result.stderr)
  })
})

test('--print-config reports the request without running anything', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mxc-print-'))
  try {
    const result = spawnSync(process.execPath, [
      RUNNER,
      '--workspace', base, '--mode', 'read-only', '--exec', join(base, 'wxc-exec.exe'),
      '--denied-path', join(base, 'secret'), '--print-config', '--', 'cmd', '/c', 'exit', '0',
    ], { cwd: base, env: process.env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const printed = JSON.parse(result.stdout)
    assert.equal(printed.version, '1.0.0')
    assert.deepEqual(printed.filesystem.deniedPaths, [join(base, 'secret')])
    assert.equal(printed.process.commandLine, 'cmd /c exit 0')
    // The print carries the child environment, so it warns that it is sensitive.
    assert.ok(result.stderr.includes(RUNNER_SIGNATURE + ': note: this request contains the full child environment'), result.stderr)
    assert.deepEqual(readdirSync(base), [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a child environment MXC would refuse is named before the launch is attempted', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mxc-env-'))
  const workspace = join(base, 'ws')
  const tempRoot = join(base, 'tmp')
  mkdirSync(workspace)
  mkdirSync(tempRoot)
  try {
    const env = { ...process.env }
    for (const name of Object.keys(env)) {
      if (['SYSTEMROOT', 'LOCALAPPDATA', 'TMP', 'TEMP', 'DSH_SUBPROCESS_CONTROL'].includes(name.toUpperCase())) delete env[name]
    }
    const result = spawnSync(process.execPath, [
      RUNNER, '--workspace', workspace, '--mode', 'workspace-write', '--exec', process.execPath,
      '--temp', tempRoot, '--', 'cmd',
    ], { cwd: workspace, env, encoding: 'utf8' })
    assert.equal(result.status, RUNNER_FAILURE_EXIT)
    // Windows restores SYSTEMROOT for every process, so the missing entry is
    // reported from what the environment block actually lacks.
    assert.ok(result.stderr.includes('MXC refuses an explicit environment without '), result.stderr)
    assert.ok(result.stderr.includes('LOCALAPPDATA'), result.stderr)
    assert.ok(result.stderr.includes('environment: child+profile'), result.stderr)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
