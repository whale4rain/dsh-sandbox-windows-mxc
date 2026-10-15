import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { ARGV_SEPARATOR, buildRunnerArgv, configFromFacts, parseRunnerArgv } from '../src/argv.js'

/** A fully-specified option set, the way the provider builds it. */
function options(overrides = {}) {
  return {
    nodePath: 'node',
    runnerPath: 'runner.js',
    argv: ['pwsh', '-NoProfile', '-Command', 'Get-Location'],
    mode: 'workspace-write',
    workspaceRoot: join('C:', 'ws'),
    execPath: join('C:', 'mxc', 'wxc-exec.exe'),
    contractVersion: '1.0.0',
    tempRoot: join('C:', 'Users', 'u', 'AppData', 'Local', 'Temp'),
    containment: 'processcontainer',
    network: 'allow',
    environment: 'child',
    ui: 'allow',
    clipboard: 'none',
    allowInputInjection: false,
    readOnlyRoots: [join('C:', 'Program Files', 'nodejs')],
    deniedPaths: [join('C:', 'secret')],
    containerId: 'dsh-test',
    allowDaclMutation: true,
    preservePolicy: false,
    denialReport: undefined,
    retainEtl: false,
    mxcArgs: [],
    ...overrides,
  }
}

test('the wrapped argv starts with the runner and ends with the caller argv', () => {
  const argv = buildRunnerArgv(options())
  assert.equal(argv[0], 'node')
  assert.equal(argv[1], 'runner.js')
  assert.equal(argv[argv.length - 4], 'pwsh')
  assert.equal(argv[argv.length - 1], 'Get-Location')
  assert.deepEqual(argv.slice(-4), ['pwsh', '-NoProfile', '-Command', 'Get-Location'])
  assert.ok(argv.includes(ARGV_SEPARATOR))
})

test('build and parse agree over a fully-specified argv', () => {
  const argv = buildRunnerArgv(options({ denialReport: join('C:', 'denials.json'), retainEtl: true, preservePolicy: true, mxcArgs: ['--debug'], network: 'deny', environment: 'child+profile', allowDaclMutation: false }))
  const facts = parseRunnerArgv(argv.slice(2))
  assert.deepEqual(facts, {
    workspaceRoot: join('C:', 'ws'),
    mode: 'workspace-write',
    execPath: join('C:', 'mxc', 'wxc-exec.exe'),
    contractVersion: '1.0.0',
    tempRoot: join('C:', 'Users', 'u', 'AppData', 'Local', 'Temp'),
    containment: 'processcontainer',
    network: 'deny',
    environment: 'child+profile',
    ui: 'allow',
    clipboard: 'none',
    allowInputInjection: false,
    containerId: 'dsh-test',
    daclMutation: 'deny',
    denialReport: join('C:', 'denials.json'),
    preservePolicy: true,
    retainEtl: true,
    printConfig: false,
    readOnlyRoots: [join('C:', 'Program Files', 'nodejs')],
    deniedPaths: [join('C:', 'secret')],
    mxcArgs: ['--debug'],
    argv: ['pwsh', '-NoProfile', '-Command', 'Get-Location'],
  })
})

test('read-only names no temp root', () => {
  const argv = buildRunnerArgv(options({ mode: 'read-only', tempRoot: undefined }))
  assert.ok(!argv.includes('--temp'))
  const facts = parseRunnerArgv(argv.slice(2))
  assert.equal(facts.tempRoot, undefined)
  assert.equal(facts.mode, 'read-only')
})

test('an unpinned contract version is simply absent from the argv', () => {
  const argv = buildRunnerArgv(options({ contractVersion: undefined }))
  assert.ok(!argv.includes('--contract-version'))
  assert.equal(parseRunnerArgv(argv.slice(2)).contractVersion, undefined)
})

test('defaults apply when only the required facts are given', () => {
  const facts = parseRunnerArgv(['--workspace', 'ws', '--mode', 'read-only', '--exec', 'exec.exe', '--', 'cmd'])
  assert.equal(facts.containment, 'processcontainer')
  assert.equal(facts.network, 'allow')
  assert.equal(facts.environment, 'child')
  assert.equal(facts.ui, 'allow')
  assert.equal(facts.clipboard, 'none')
  assert.equal(facts.allowInputInjection, false)
  assert.equal(facts.daclMutation, 'allow')
  assert.equal(facts.preservePolicy, false)
  assert.equal(facts.retainEtl, false)
  assert.equal(facts.printConfig, false)
  assert.equal(facts.containerId, undefined)
  assert.equal(facts.contractVersion, undefined)
  assert.deepEqual(facts.readOnlyRoots, [])
  assert.deepEqual(facts.deniedPaths, [])
  assert.deepEqual(facts.mxcArgs, [])
  assert.deepEqual(facts.argv, ['cmd'])
})

test('parsed facts project onto the request-builder configuration', () => {
  const facts = parseRunnerArgv(['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--dacl-mutation', 'deny', '--preserve-policy', '--', 'cmd'])
  const config = configFromFacts(facts)
  assert.equal(config.allowDaclMutation, false)
  assert.equal(config.clearPolicyOnExit, false)
  assert.equal(config.containment, 'processcontainer')
  assert.equal(config.denialReport, undefined)
  assert.equal(config.retainEtl, false)
})

test('malformed arguments are refused by name', () => {
  const cases = [
    [[], /missing --workspace/],
    [['--workspace', 'ws'], /unknown mode: undefined/],
    [['--workspace', 'ws', '--mode', 'read-only'], /missing --exec/],
    [['--workspace', 'ws', '--mode', 'process', '--exec', 'x', '--', 'cmd'], /unknown mode: process/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec'], /missing value after --exec/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--containment', 'microvm', '--', 'cmd'], /unknown containment: microvm/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--network', 'maybe', '--', 'cmd'], /unknown network posture: maybe/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--environment', 'profile', '--', 'cmd'], /unknown environment mode: profile/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--ui', 'sometimes', '--', 'cmd'], /unknown ui posture: sometimes/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--clipboard', 'everything', '--', 'cmd'], /unknown clipboard level: everything/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--dacl-mutation', 'sometimes', '--', 'cmd'], /unknown dacl-mutation: sometimes/],
    [['--workspace', 'ws', '--mode', 'workspace-write', '--exec', 'x', '--', 'cmd'], /workspace-write requires --temp/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x', '--temp', 't', '--', 'cmd'], /read-only does not accept --temp/],
    [['--workspace', 'ws', '--mode', 'read-only', '--exec', 'x'], /missing command after --/],
  ]
  for (const [raw, pattern] of cases) {
    assert.throws(() => parseRunnerArgv(raw), pattern, JSON.stringify(raw))
  }
})
