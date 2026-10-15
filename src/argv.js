/**
 * The runner's argv dialect: the provider builds it, the runner parses it, and
 * both halves live here so they cannot drift.
 *
 * The shape mirrors the shipped `dsh-sandbox-windows-acl` rung — a runner
 * program, the policy facts, `--`, then the caller's exact argv — so an operator
 * reading a wrapped command recognizes either backend. The policy facts are
 * spelled out as flags rather than embedded as an opaque blob, so a denied
 * command's argv is itself the diagnosis.
 *
 * @module dsh-sandbox-windows-mxc/argv
 */

import { CONTAINMENTS, ENVIRONMENT_MODES, NETWORK_POSTURES } from './config.js'

/** The flags that carry a single value. */
const VALUE_FLAGS = new Map([
  ['--workspace', 'workspaceRoot'],
  ['--mode', 'mode'],
  ['--exec', 'execPath'],
  ['--temp', 'tempRoot'],
  ['--containment', 'containment'],
  ['--network', 'network'],
  ['--environment', 'environment'],
  ['--container-id', 'containerId'],
  ['--dacl-mutation', 'daclMutation'],
  ['--denial-report', 'denialReport'],
])

/** The repeatable value flags. */
const REPEAT_FLAGS = new Map([
  ['--read-only-root', 'readOnlyRoots'],
  ['--denied-path', 'deniedPaths'],
  ['--mxc-arg', 'mxcArgs'],
])

/** The valueless flags. */
const BOOLEAN_FLAGS = new Map([
  ['--preserve-policy', 'preservePolicy'],
  ['--retain-etl', 'retainEtl'],
  ['--print-config', 'printConfig'],
])

/** The separator between the runner's own flags and the caller's argv. */
export const ARGV_SEPARATOR = '--'

/** The accepted usage, as the runner's failure message spells it. */
export const RUNNER_USAGE = [
  'usage: <node> runner.js --workspace <dir> --mode <read-only|workspace-write> --exec <wxc-exec path>',
  '       [--temp <dir>] [--containment <processcontainer|process>] [--network <allow|deny>]',
  '       [--environment <child|child+profile>] [--read-only-root <dir>...] [--denied-path <dir>...]',
  '       [--container-id <id>] [--dacl-mutation <allow|deny>] [--denial-report <path>] [--retain-etl]',
  '       [--mxc-arg <arg>...] [--print-config] -- <command> [args...]',
].join('\n')

/**
 * Build the argv the harness spawns in place of the caller's own.
 * @param options - the resolved policy facts plus the caller's exact argv.
 * @param options.nodePath - the node executable that runs the runner.
 * @param options.runnerPath - the runner entry to execute.
 * @param options.argv - the caller's exact argv.
 * @param options.mode - the confined mode.
 * @param options.workspaceRoot - the canonical workspace boundary.
 * @param options.execPath - the MXC executor to invoke.
 * @param options.tempRoot - the temp root for `workspace-write`, omitted under `read-only`.
 * @param options.containment - MXC containment selection.
 * @param options.network - network posture.
 * @param options.environment - child environment mode.
 * @param options.readOnlyRoots - additional read-only grant roots.
 * @param options.deniedPaths - denied paths.
 * @param options.containerId - the derived container id.
 * @param options.allowDaclMutation - whether MXC may mutate host DACLs.
 * @param options.preservePolicy - whether the applied policy survives the command.
 * @param options.denialReport - denial-report destination, when configured.
 * @param options.retainEtl - whether the sealed ETL trace is kept.
 * @param options.mxcArgs - extra arguments passed to the MXC executor.
 * @returns the wrapped argv.
 */
export function buildRunnerArgv(options) {
  const argv = [
    options.nodePath, options.runnerPath,
    '--workspace', options.workspaceRoot,
    '--mode', options.mode,
    '--exec', options.execPath,
  ]
  if (options.tempRoot !== undefined) argv.push('--temp', options.tempRoot)
  argv.push('--containment', options.containment)
  argv.push('--network', options.network)
  argv.push('--environment', options.environment)
  argv.push('--container-id', options.containerId)
  argv.push('--dacl-mutation', options.allowDaclMutation === true ? 'allow' : 'deny')
  for (const root of options.readOnlyRoots ?? []) argv.push('--read-only-root', root)
  for (const path of options.deniedPaths ?? []) argv.push('--denied-path', path)
  if (options.denialReport !== undefined) argv.push('--denial-report', options.denialReport)
  if (options.retainEtl === true) argv.push('--retain-etl')
  if (options.preservePolicy === true) argv.push('--preserve-policy')
  for (const arg of options.mxcArgs ?? []) argv.push('--mxc-arg', arg)
  argv.push(ARGV_SEPARATOR, ...options.argv)
  return argv
}

/** Require a value after a flag. */
function requiredValue(flag, value) {
  if (value === undefined) throw new Error(`missing value after ${flag}`)
  return value
}

/**
 * Parse the runner's own arguments.
 * @param raw - `process.argv.slice(2)`.
 * @returns the policy facts plus the caller's argv.
 * @throws Error naming the offending token; the runner converts it into its
 *   failure signature and exit status rather than running anything unconfined.
 */
export function parseRunnerArgv(raw) {
  const facts = {
    workspaceRoot: undefined,
    mode: undefined,
    execPath: undefined,
    tempRoot: undefined,
    containment: 'processcontainer',
    network: 'allow',
    environment: 'child',
    containerId: undefined,
    daclMutation: 'allow',
    denialReport: undefined,
    preservePolicy: false,
    retainEtl: false,
    printConfig: false,
    readOnlyRoots: [],
    deniedPaths: [],
    mxcArgs: [],
    argv: [],
  }
  let index = 0
  for (; index < raw.length; index += 1) {
    const token = raw[index]
    if (token === ARGV_SEPARATOR) {
      index += 1
      break
    }
    if (REPEAT_FLAGS.has(token)) {
      facts[REPEAT_FLAGS.get(token)].push(requiredValue(token, raw[index + 1]))
      index += 1
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      facts[VALUE_FLAGS.get(token)] = requiredValue(token, raw[index + 1])
      index += 1
      continue
    }
    if (BOOLEAN_FLAGS.has(token)) {
      facts[BOOLEAN_FLAGS.get(token)] = true
      continue
    }
    throw new Error(`unknown argument: ${String(token)}`)
  }
  facts.argv = raw.slice(index)
  if (facts.workspaceRoot === undefined) throw new Error('missing --workspace')
  if (facts.mode !== 'read-only' && facts.mode !== 'workspace-write') throw new Error(`unknown mode: ${String(facts.mode)}`)
  if (facts.execPath === undefined) throw new Error('missing --exec')
  if (!CONTAINMENTS.includes(facts.containment)) throw new Error(`unknown containment: ${String(facts.containment)}`)
  if (!NETWORK_POSTURES.includes(facts.network)) throw new Error(`unknown network posture: ${String(facts.network)}`)
  if (!ENVIRONMENT_MODES.includes(facts.environment)) throw new Error(`unknown environment mode: ${String(facts.environment)}`)
  if (facts.daclMutation !== 'allow' && facts.daclMutation !== 'deny') throw new Error(`unknown dacl-mutation: ${String(facts.daclMutation)}`)
  if (facts.mode === 'workspace-write' && facts.tempRoot === undefined) throw new Error('workspace-write requires --temp')
  if (facts.mode === 'read-only' && facts.tempRoot !== undefined) throw new Error('read-only does not accept --temp')
  if (facts.argv.length === 0) throw new Error(`missing command after ${ARGV_SEPARATOR}`)
  return facts
}

/**
 * Project parsed runner facts onto the configuration shape the request builder
 * consumes, so the runner and the provider describe one policy the same way.
 * @param facts - the parsed runner arguments.
 * @returns the request-builder configuration.
 */
export function configFromFacts(facts) {
  return {
    containment: facts.containment,
    readOnlyRoots: facts.readOnlyRoots,
    deniedPaths: facts.deniedPaths,
    network: facts.network,
    environment: facts.environment,
    allowDaclMutation: facts.daclMutation === 'allow',
    clearPolicyOnExit: !facts.preservePolicy,
    denialReport: facts.denialReport,
    retainEtl: facts.retainEtl,
  }
}
