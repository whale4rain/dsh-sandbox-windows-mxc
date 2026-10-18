/**
 * Live acceptance: the plugin's own path against a real MXC executor.
 *
 * Not part of `npm test`: it needs an installed `wxc-exec.exe` (see the README's
 * requirements) and it really launches contained processes, including a
 * deliberate denied write outside the workspace. Run it after installing or
 * upgrading the SDK:
 *
 *   node tests/live/acceptance.mjs
 *   DSH_MXC_EXEC=C:\path\wxc-exec.exe DSH_MXC_CONTRACT=0.9.0-alpha node tests/live/acceptance.mjs
 *
 * Every case is an assertion; the process exits non-zero and prints which one
 * failed. Nothing outside the workspace and the granted temp area is written:
 * the denied case names a path it expects to be refused, and removes it if the
 * sandbox ever lets the write through.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import MxcSandboxProvider from '../../index.js'

const WORKSPACE = process.cwd()
const CONTRACT = process.env.DSH_MXC_CONTRACT
/**
 * The workspace's volume root, granted read-only.
 *
 * Not cosmetic: Node's module resolution lstats every parent directory of its
 * entry script, and inside the container an ungranted \`D:\` fails that with
 * EPERM ("operation not permitted, lstat 'D:\'"), so every Node process in the
 * sandbox dies before running a line. The platform's own remedy is
 * `wxc-host-prep prepare-system-drive --target D:\` (one elevated, non-inheriting
 * read-attributes ACE); this grant is the no-elevation equivalent and is what a
 * profile whose workspace lives off the system drive needs either way.
 */
const VOLUME_ROOT = parse(resolve(WORKSPACE)).root
const FIXTURE = join(WORKSPACE, 'tests', 'live', 'fixtures', 'piped-stdio.cjs')
/** A path outside the workspace and the temp area: the write must be denied. */
const DENIED_TARGET = join(WORKSPACE, '..', 'dsh-mxc-acceptance-denied.txt')
const INSIDE_TARGET = join(WORKSPACE, 'dsh-mxc-acceptance-inside.txt')

const failures = []

/**
 * Confine one argv through the provider, spawn exactly what it returned, and
 * report the observation.
 * @param mode - the confined file-effect mode.
 * @param argv - the exact argv the caller would spawn.
 * @returns the confined facts and the spawn result.
 */
async function run(mode, argv) {
  const provider = new MxcSandboxProvider(new Context(), {
    ...process.env.DSH_MXC_EXEC === undefined ? {} : { execPath: process.env.DSH_MXC_EXEC },
    ...CONTRACT === undefined ? {} : { contractVersion: CONTRACT },
    readOnlyRoots: [VOLUME_ROOT],
  })
  const confined = await provider.confine(argv, { mode, workspaceRoot: WORKSPACE })
  const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8', cwd: WORKSPACE })
  return { confined, result }
}

/** Record a case's outcome. */
function check(label, condition, detail) {
  process.stdout.write((condition ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' — ' + detail) + '\n')
  if (!condition) failures.push(label)
}

rmSync(INSIDE_TARGET, { force: true })
rmSync(DENIED_TARGET, { force: true })

const readOnly = await run('read-only', ['cmd', '/c', 'echo mxc-acceptance'])
check('read-only command runs confined and relayed',
  readOnly.result.status === 0 && (readOnly.result.stdout ?? '').includes('mxc-acceptance'),
  'exit=' + readOnly.result.status + ' stdout=' + JSON.stringify((readOnly.result.stdout ?? '').trim()))
check('enforcement is reported as partial', readOnly.confined.enforcement === 'partial', readOnly.confined.enforcement)

const writeInside = await run('workspace-write', ['cmd', '/c', 'echo inside> ' + INSIDE_TARGET])
let insideContent
try { insideContent = readFileSync(INSIDE_TARGET, 'utf8').trim() } catch { insideContent = undefined }
check('a write inside the workspace is allowed', writeInside.result.status === 0 && insideContent === 'inside',
  'exit=' + writeInside.result.status + ' content=' + JSON.stringify(insideContent))

const writeOutside = await run('workspace-write', ['cmd', '/c', 'echo escaped> ' + DENIED_TARGET])
const escaped = existsSync(DENIED_TARGET)
check('a write outside the workspace is denied', writeOutside.result.status !== 0 && !escaped,
  'exit=' + writeOutside.result.status + ' file=' + escaped)

// Control: the same write, unconfined, must succeed — otherwise the denial
// above would prove nothing about the sandbox.
rmSync(DENIED_TARGET, { force: true })
const control = spawnSync('cmd', ['/c', 'echo control> ' + DENIED_TARGET], { encoding: 'utf8', cwd: WORKSPACE })
check('the same write succeeds unconfined (control)', control.status === 0 && existsSync(DENIED_TARGET),
  'exit=' + control.status)
rmSync(DENIED_TARGET, { force: true })

// The consumer's view: it only sees the child's stderr, decoded as UTF-8.
const observed = (writeOutside.result.stderr ?? '').toLowerCase()
const matched = writeOutside.confined.denialSignatures.filter(signature => observed.includes(signature.toLowerCase()))
check('the denied write is recognisable as a denial', matched.length > 0,
  'matched=' + JSON.stringify(matched) + ' dialect=' + JSON.stringify(writeOutside.confined.denialSignatures))

rmSync(INSIDE_TARGET, { force: true })
rmSync(DENIED_TARGET, { force: true })

// The harness's ACL backend documents piped stdio for confined grandchildren as
// impossible (libuv's named pipes deny the client-end open). Assert the same
// pattern here: a Node grandchild with piped stdio, and a named pipe this
// confined process creates and opens itself.
const piped = await run('workspace-write', ['node', FIXTURE])
const pipedLines = (piped.result.stdout ?? '').split(/\r?\n/u).filter(line => line.startsWith('{'))
const pipedCases = pipedLines.map(line => JSON.parse(line))
const failedPipes = pipedCases.filter(entry => entry.ok !== true)
check('a Node grandchild with piped stdio works inside the sandbox',
  piped.result.status === 0 && pipedCases.length === 4 && failedPipes.length === 0,
  'exit=' + piped.result.status + ' cases=' + pipedCases.map(entry => entry.label + ':' + entry.ok).join(' ')
    + (piped.result.status === 0 ? '' : ' stderr=' + JSON.stringify((piped.result.stderr ?? '').trim().slice(0, 160))))

// A contract no MXC build supports must be refused BEFORE anything runs: this is
// the fail-closed path an operator meets after upgrading or downgrading the SDK.
try {
  await (async () => {
    const provider = new MxcSandboxProvider(new Context(), {
      ...process.env.DSH_MXC_EXEC === undefined ? {} : { execPath: process.env.DSH_MXC_EXEC },
      contractVersion: '0.0.1',
    })
    const confined = await provider.confine(['cmd', '/c', 'echo nope'], { mode: 'read-only', workspaceRoot: WORKSPACE })
    check('an unsupported contract is refused before running', false, 'it returned argv ' + JSON.stringify(confined.argv.slice(0, 3)))
  })()
} catch (error) {
  check('an unsupported contract is refused before running',
    error?.code === 'SANDBOX_UNAVAILABLE' && typeof error.message === 'string' && error.message.includes('refuses this request'),
    error?.code + ' — ' + String(error?.message ?? error).split('Runner failure: ')[1]?.slice(0, 140))
}

if (failures.length > 0) {
  process.stderr.write('\n' + failures.length + ' acceptance case(s) failed\n')
  process.exitCode = 1
} else {
  process.stdout.write('\nall acceptance cases passed (contract ' + (CONTRACT ?? 'plugin default') + ')\n')
}
