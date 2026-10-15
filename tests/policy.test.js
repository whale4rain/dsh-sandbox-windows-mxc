import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { MXC_CONTRACT_VERSION, buildMxcRequest, childEnvironment, containerIdFor, environmentEntries } from '../src/policy.js'

const WS = join('C:', 'ws')
const TEMP = join('C:', 'Users', 'u', 'AppData', 'Local', 'Temp', 'dsh-mxc-abc')
const CWD = join('C:', 'ws', 'sub')
const ENV = { SystemRoot: join('C:', 'Windows'), LOCALAPPDATA: join('C:', 'Users', 'u', 'AppData', 'Local') }

/** Build a request with the given overrides. */
function request(overrides = {}) {
  return buildMxcRequest({
    config: normalizeConfig(overrides.config),
    mode: 'workspace-write',
    workspaceRoot: WS,
    privateTempDir: TEMP,
    commandLine: 'cmd /c "echo hi"',
    cwd: CWD,
    env: ENV,
    containerId: 'dsh-test',
    ...overrides.request,
  })
}

test('the request carries the exact contract version and the derived identity', () => {
  const built = request()
  assert.equal(built.version, MXC_CONTRACT_VERSION)
  assert.equal(built.version, '1.0.0')
  // An operator running an older SDK pins its contract instead of downgrading.
  assert.equal(request({ config: { contractVersion: '0.9.0-alpha' } }).version, '0.9.0-alpha')
  // The runner, invoked on its own, still defaults to the plugin's contract.
  assert.equal(request({ config: {} }).version, '1.0.0')
  assert.equal(built.containment, 'processcontainer')
  assert.equal(built.containerId, 'dsh-test')
})

test('workspace-write grants the workspace and the private temp directory', () => {
  const built = request()
  assert.deepEqual(built.filesystem.readwritePaths, [WS, TEMP])
  assert.deepEqual(built.filesystem.readonlyPaths, [])
  assert.deepEqual(built.filesystem.deniedPaths, [])
  assert.equal(built.process.cwd, CWD)
  assert.equal(built.process.commandLine, 'cmd /c "echo hi"')
  // The field is omitted rather than spelled out as false: omission is the same
  // meaning in the exact contract, and an older executor rejects the spelling.
  assert.equal('inheritDefaultEnv' in built.process, false)
  assert.deepEqual(built.process.env, ['LOCALAPPDATA=' + ENV.LOCALAPPDATA, 'SystemRoot=' + ENV.SystemRoot])
  // No execution timeout: the harness's shell executor owns command deadlines.
  assert.equal('timeout' in built.process, false)
})

test('read-only grants no writable root and still grants reads of the workspace', () => {
  const built = request({ request: { mode: 'read-only', privateTempDir: undefined }, env: ENV })
  assert.deepEqual(built.filesystem.readwritePaths, [])
  assert.deepEqual(built.filesystem.readonlyPaths, [WS])
  assert.deepEqual(built.filesystem.deniedPaths, [])
})

test('operator roots are added to the read-only grants and deduplicated', () => {
  const root = join('C:', 'Tools')
  const built = request({ config: { readOnlyRoots: [root, WS, root], deniedPaths: [join('C:', 'secret')] } })
  assert.deepEqual(built.filesystem.readonlyPaths, [root, WS])
  assert.deepEqual(built.filesystem.deniedPaths, [join('C:', 'secret')])
})

test('the user-interface policy is stated explicitly in both directions', () => {
  // MXC's own default is `disable: true`, so the plugin's "leave the desktop
  // reachable" default has to be written out to mean anything.
  assert.deepEqual(request().ui, { disable: false, clipboard: 'none', injection: false })
  assert.deepEqual(request({ config: { ui: 'deny' } }).ui, { disable: true, clipboard: 'none', injection: false })
  assert.deepEqual(request({ config: { ui: 'deny', clipboard: 'all', allowInputInjection: true } }).ui,
    { disable: true, clipboard: 'all', injection: true })
})

test('the default network posture is unrestricted, and deny is available', () => {
  assert.deepEqual(request().network, {
    egress: { default: 'allow' },
    ingress: { default: 'allow', hostLoopback: 'allow' },
  })
  assert.deepEqual(request({ config: { network: 'deny' } }).network, {
    egress: { default: 'deny' },
    ingress: { default: 'deny', hostLoopback: 'deny' },
  })
})

test('lifecycle and fallback state the per-call model', () => {
  const built = request()
  assert.deepEqual(built.lifecycle, { destroyOnExit: true, preservePolicy: false })
  assert.deepEqual(built.fallback, { allowDaclMutation: true })
  const kept = request({ config: { clearPolicyOnExit: false, allowDaclMutation: false } })
  assert.equal(kept.lifecycle.preservePolicy, true)
  assert.equal(kept.fallback.allowDaclMutation, false)
})

test('the environment mode selects whether MXC layers the profile default', () => {
  assert.equal(request({ config: { environment: 'child+profile' } }).process.inheritDefaultEnv, true)
  assert.equal('inheritDefaultEnv' in request().process, false)
})

test('denial diagnosis adds only the ProcessContainer section MXC accepts', () => {
  const plain = request()
  assert.equal('processContainer' in plain, false)
  const withReport = request({ config: { denialReport: join('C:', 'denials.json') } })
  assert.deepEqual(withReport.processContainer, { captureDenials: { mode: 'block', outputPath: join('C:', 'denials.json') } })
  const retained = request({ config: { denialReport: join('C:', 'denials.json'), retainEtl: true } })
  assert.equal(retained.processContainer.captureDenials.retainEtl, true)
})

test('container ids are stable per workspace and session, and carry no path', () => {
  const first = containerIdFor(WS, 'session-1')
  assert.equal(first, containerIdFor(WS, 'session-1'))
  assert.notEqual(first, containerIdFor(WS, 'session-2'))
  assert.notEqual(first, containerIdFor(join('C:', 'other'), 'session-1'))
  assert.equal(containerIdFor(WS, undefined), containerIdFor(WS, undefined))
  assert.notEqual(containerIdFor(WS, undefined), first)
  assert.match(first, /^dsh-[0-9a-f]{24}$/)
})

test('the child environment drops internal entries and publishes the granted temp', () => {
  const env = childEnvironment({
    Path: 'C:' + String.fromCharCode(92) + 'bin',
    TEMP: 'ambient',
    Temp: 'shadow',
    DSH_SUBPROCESS_CONTROL: 'pipe',
  }, TEMP)
  assert.deepEqual(env, { Path: 'C:' + String.fromCharCode(92) + 'bin', TMP: TEMP, TEMP: TEMP })
  // Read-only grants nothing, so the ambient temp entries stay as the caller set them.
  const untouched = childEnvironment({ TEMP: 'ambient', DSH_SUBPROCESS_CONTROL: 'pipe' }, undefined)
  assert.deepEqual(untouched, { TEMP: 'ambient' })
})

test('environment entries are sorted KEY=VALUE strings', () => {
  assert.deepEqual(environmentEntries({ B: '2', A: '1', C: 'x=y' }), ['A=1', 'B=2', 'C=x=y'])
  assert.deepEqual(environmentEntries({ '': 'ignored' }), [])
})
