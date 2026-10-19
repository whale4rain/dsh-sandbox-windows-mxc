/**
 * Print the real four-layer launch chain for one command, for the docs and for
 * anyone asking "how is this actually wired".
 *
 * Run from the repository root: `node tests/live/chain.mjs`.
 *
 * It builds the argv with the provider's own builder rather than calling
 * `confine()`, because `confine()` also verifies the executor (which would need
 * a real MXC payload just to print a diagram). Everything printed here is
 * produced by the same code paths a real call uses.
 */

import { buildRunnerArgv } from '../../src/argv.js'
import { buildMxcRequest, containerIdFor } from '../../src/policy.js'
import { windowsCommandLine } from '../../src/quote.js'

const command = 'node -e "console.log(1+1)"'
const callerArgv = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
const workspace = process.cwd()
const volume = workspace.slice(0, 3)
const config = {
  containment: 'processcontainer',
  contractVersion: '0.9.0-alpha',
  readOnlyRoots: [volume],
  deniedPaths: [],
  network: 'allow',
  environment: 'child',
  ui: 'allow',
  clipboard: 'none',
  allowInputInjection: false,
  allowDaclMutation: true,
  clearPolicyOnExit: true,
  retainEtl: false,
}

const confined = buildRunnerArgv({
  nodePath: process.execPath,
  runnerPath: '<package>\\runner.js',
  argv: callerArgv,
  mode: 'workspace-write',
  workspaceRoot: workspace,
  execPath: '<sdk>\\bin\\x64\\wxc-exec.exe',
  tempRoot: '<ambient temp>',
  containment: config.containment,
  contractVersion: config.contractVersion,
  network: config.network,
  environment: config.environment,
  ui: config.ui,
  clipboard: config.clipboard,
  allowInputInjection: config.allowInputInjection,
  readOnlyRoots: config.readOnlyRoots,
  deniedPaths: config.deniedPaths,
  containerId: containerIdFor(workspace, 'session-id'),
  allowDaclMutation: config.allowDaclMutation,
  preservePolicy: !config.clearPolicyOnExit,
  denialReport: undefined,
  retainEtl: config.retainEtl,
  mxcArgs: [],
})

console.log('L0  the harness executor argv (what dsh-pwsh-sandbox builds):')
console.log('    ' + JSON.stringify(callerArgv))
console.log()
console.log('L1  confined.argv (what the harness spawns):')
for (const part of confined) console.log('    ' + JSON.stringify(part))
console.log()
const request = buildMxcRequest({
  config,
  mode: 'workspace-write',
  workspaceRoot: workspace,
  privateTempDir: '<ambient temp>\\dsh-mxc-xxxxxx',
  commandLine: windowsCommandLine(callerArgv),
  cwd: workspace,
  env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: '<profile>\\AppData\\Local' },
  containerId: containerIdFor(workspace, 'session-id'),
})
console.log('L2  the request the runner writes, then hands to "wxc-exec <file>":')
console.log('    process.commandLine  = ' + JSON.stringify(request.process.commandLine))
console.log('    process.cwd          = ' + JSON.stringify(request.process.cwd))
console.log('    filesystem.readwrite = ' + JSON.stringify(request.filesystem.readwritePaths))
console.log('    filesystem.readonly  = ' + JSON.stringify(request.filesystem.readonlyPaths))
console.log()
console.log('L3  wxc-exec CreateProcess(commandLine) inside the container.')
console.log('    stdin/stdout inherited; stderr piped and relayed (envelope detection).')
