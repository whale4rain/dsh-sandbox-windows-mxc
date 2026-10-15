import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_KEYS, normalizeConfig } from '../src/config.js'

/** Assert that a row is refused and that the message names the field. */
function refuses(config, pattern) {
  assert.throws(() => normalizeConfig(config), pattern)
}

test('defaults are the shipped selection policy', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual({ ...config }, {
    execPath: undefined,
    containment: 'processcontainer',
    readOnlyRoots: [],
    deniedPaths: [],
    network: 'allow',
    environment: 'child',
    allowDaclMutation: true,
    clearPolicyOnExit: true,
    denialReport: undefined,
    retainEtl: false,
    mxcArgs: [],
  })
  assert.ok(Object.isFrozen(config))
  assert.deepEqual(normalizeConfig(null).containment, 'processcontainer')
})

test('a full row is accepted and frozen', () => {
  const config = normalizeConfig({
    execPath: 'exec.exe',
    containment: 'process',
    readOnlyRoots: ['tools'],
    deniedPaths: ['secret'],
    network: 'deny',
    environment: 'child+profile',
    allowDaclMutation: false,
    clearPolicyOnExit: false,
    mxcArgs: ['--debug'],
  })
  assert.equal(config.execPath, 'exec.exe')
  assert.equal(config.containment, 'process')
  assert.deepEqual(config.readOnlyRoots, ['tools'])
  assert.deepEqual(config.deniedPaths, ['secret'])
  assert.equal(config.network, 'deny')
  assert.equal(config.environment, 'child+profile')
  assert.equal(config.allowDaclMutation, false)
  assert.equal(config.clearPolicyOnExit, false)
  assert.deepEqual(config.mxcArgs, ['--debug'])
  assert.ok(Object.isFrozen(config.readOnlyRoots))
})

test('unknown fields are refused rather than ignored', () => {
  refuses({ runnerCommand: ['x'] }, /unknown config field "runnerCommand"/)
  refuses({ readOnlyRoot: [] }, /unknown config field/)
  assert.ok(CONFIG_KEYS.includes('readOnlyRoots'))
})

test('enum fields name their accepted values', () => {
  refuses({ containment: 'microvm' }, /containment must be one of "processcontainer", "process"/)
  refuses({ network: 'sometimes' }, /network must be one of "allow", "deny"/)
  refuses({ environment: 'profile' }, /environment must be one of "child", "child\+profile"/)
})

test('scalar fields reject the wrong type', () => {
  refuses({ execPath: '' }, /execPath must be a non-empty string/)
  refuses({ execPath: 42 }, /execPath must be a non-empty string/)
  refuses({ allowDaclMutation: 'yes' }, /allowDaclMutation must be a boolean/)
  refuses({ readOnlyRoots: 'tools' }, /readOnlyRoots must be an array of strings/)
  refuses({ readOnlyRoots: ['ok', ''] }, /readOnlyRoots entries must be a non-empty string/)
  refuses({ mxcArgs: [1] }, /mxcArgs entries must be a non-empty string/)
  refuses([], /config must be a mapping/)
})

test('denial diagnosis requires the ProcessContainer section it lives in', () => {
  refuses({ retainEtl: true }, /retainEtl requires denialReport/)
  refuses({ denialReport: 'denials.json', containment: 'process' },
    /denialReport requires containment "processcontainer"/)
  const config = normalizeConfig({ denialReport: 'denials.json', retainEtl: true })
  assert.equal(config.denialReport, 'denials.json')
  assert.equal(config.retainEtl, true)
})
