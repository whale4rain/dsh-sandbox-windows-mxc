import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXEC_ENVIRONMENT, EXEC_NAME, SDK_PACKAGE, architectureCandidates, locateMxcExec, locateRunnerEntry } from '../src/locate.js'

const SDK_ROOT = join('C:', 'node_modules', '@microsoft', 'mxc-sdk')
const MANIFEST = join(SDK_ROOT, 'package.json')
const X64 = join(SDK_ROOT, 'bin', 'x64', EXEC_NAME)
const ARM64 = join(SDK_ROOT, 'bin', 'arm64', EXEC_NAME)

test('the running architecture is preferred, and the other is still tried', () => {
  assert.deepEqual(architectureCandidates('arm64'), ['arm64', 'x64'])
  assert.deepEqual(architectureCandidates('x64'), ['x64', 'arm64'])
  assert.deepEqual(architectureCandidates('ia32'), ['x64', 'arm64'])
})

test('a configured executor wins and must exist', () => {
  const configured = join('C:', 'mxc', EXEC_NAME)
  assert.equal(locateMxcExec({
    configuredPath: configured,
    env: { [EXEC_ENVIRONMENT]: join('C:', 'other', EXEC_NAME) },
    exists: path => path === configured,
    resolvePackageJson: () => MANIFEST,
  }), configured)
  assert.throws(() => locateMxcExec({ configuredPath: configured, exists: () => false }),
    /execPath does not exist/)
})

test('the environment variable is the second source', () => {
  const fromEnvironment = join('C:', 'tools', EXEC_NAME)
  assert.equal(locateMxcExec({
    env: { [EXEC_ENVIRONMENT]: fromEnvironment },
    exists: path => path === fromEnvironment,
    resolvePackageJson: () => { throw new Error('unused') },
  }), fromEnvironment)
  assert.throws(() => locateMxcExec({ env: { [EXEC_ENVIRONMENT]: fromEnvironment }, exists: () => false }),
    /DSH_MXC_EXEC does not exist/)
  // An empty variable is not an override.
  assert.equal(locateMxcExec({
    env: { [EXEC_ENVIRONMENT]: '' },
    arch: 'x64',
    exists: path => path === X64,
    resolvePackageJson: () => MANIFEST,
  }), X64)
})

test('the SDK payload supplies the executor', () => {
  assert.equal(locateMxcExec({ arch: 'x64', exists: path => path === X64, resolvePackageJson: () => MANIFEST }), X64)
  // An arm64 host without the arm64 payload still uses the shipped x64 build.
  assert.equal(locateMxcExec({ arch: 'arm64', exists: path => path === X64, resolvePackageJson: () => MANIFEST }), X64)
  assert.equal(locateMxcExec({ arch: 'arm64', exists: path => path === ARM64 || path === X64, resolvePackageJson: () => MANIFEST }), ARM64)
})

test('an unresolvable or incomplete SDK names every alternative', () => {
  assert.throws(() => locateMxcExec({
    env: {},
    exists: () => false,
    resolvePackageJson: () => { throw new Error('MODULE_NOT_FOUND') },
  }), new RegExp('cannot resolve ' + SDK_PACKAGE.replace('/', '/') + ' .*install it, set execPath, or set ' + EXEC_ENVIRONMENT))
  assert.throws(() => locateMxcExec({ arch: 'x64', exists: () => false, resolvePackageJson: () => MANIFEST }),
    new RegExp('ships no ' + EXEC_NAME.replace('.', '\\.') + ' for x64 or arm64'))
})

test('the runner entry resolves by specifier, with a sibling fallback', () => {
  const bySpecifier = join('C:', 'pkg', 'runner.js')
  assert.equal(locateRunnerEntry({
    resolve: () => 'file:///C:/pkg/runner.js',
    exists: path => path === bySpecifier,
    selfUrl: 'file:///C:/pkg/src/locate.js',
  }), bySpecifier)
  const sibling = fileURLToPath(new URL('../runner.js', 'file:///C:/pkg/src/locate.js'))
  assert.equal(locateRunnerEntry({ resolve: () => { throw new Error('no self reference') }, exists: () => false, selfUrl: 'file:///C:/pkg/src/locate.js' }), sibling)
  assert.equal(locateRunnerEntry({ resolve: () => undefined, exists: () => false, selfUrl: 'file:///C:/pkg/src/locate.js' }), sibling)
  assert.equal(locateRunnerEntry({ resolve: () => 'file:///C:/pkg/runner.js', exists: () => false, selfUrl: 'file:///C:/pkg/src/locate.js' }), sibling)
})
