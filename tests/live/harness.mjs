/**
 * Harness integration: boot a real dsh profile and run a command through the
 * harness's own shell tool path, so the plugin is exercised as the harness
 * mounts it rather than as a standalone module.
 *
 * This is the check that answers "is it actually installed and working in my
 * dsh": the profile is loaded exactly the way the CLI loads it (bundle patch
 * layers in `dsh.profile.bundles` order, then the profile's own patch file),
 * the tree is booted, and the assertions are made on the live services —
 * `ctx.sandbox` must be this plugin's provider, and `ctx.shell` (the real
 * dsh-pwsh-sandbox executor) must run commands through it under MXC.
 *
 *   node tests/live/harness.mjs                       # profile "web" under DSH_HOME
 *   DSH_HARNESS_PROFILE=web node tests/live/harness.mjs
 *
 * Environment:
 * - `DSH_HARNESS_LIBS`: the node_modules directory of the dsh installation
 *   (default `%USERPROFILE%/.dsh/profiles/node_modules`).
 * - `DSH_HARNESS_PROFILE`: the profile to boot (default `web`).
 * - `DSH_HOME`: the harness home the profile lives under.
 *
 * It boots the profile's real tree, so the app it mounts starts too (the web
 * profile's HTTP surface included); the process exits as soon as the checks are
 * done.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const libs = resolve(process.env.DSH_HARNESS_LIBS ?? join(process.env.USERPROFILE ?? '.', '.dsh', 'profiles', 'node_modules'))
const profileName = process.env.DSH_HARNESS_PROFILE ?? 'web'
const workspace = process.cwd()
/** Outside the sandbox's workspace root and its temp area: the write must be denied. */
const DENIED_TARGET = join(resolve(workspace, '..'), 'mxc-harness-denied.txt')
const INSIDE_TARGET = join(workspace, 'mxc-harness-inside.txt')

const failures = []

/**
 * Record one case's outcome.
 * @param label - the case's name.
 * @param condition - whether it held.
 * @param detail - the observation to print alongside.
 */
function check(label, condition, detail) {
  process.stdout.write((condition ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' — ' + detail) + '\n')
  if (!condition) failures.push(label)
}

/** Load one harness module by its path inside the installation. */
async function lib(relative) {
  return import(pathToFileURL(join(libs, relative)).href)
}

const appBoot = await lib('@deepseek-ai/dsh-app-boot/lib/index.js')
const cmdline = await lib('@deepseek-ai/dsh-cmdline/lib/index.js')
const launchEnvironment = await lib('@deepseek-ai/dsh-launch-environment/lib/index.js')
const homePaths = await lib('@deepseek-ai/dsh-home-paths/lib/index.js')
/**
 * The running dsh app's manifest — the first resolution anchor for bundles.
 *
 * It cannot simply be `<libs>/@deepseek-ai/dsh/package.json`: an installation
 * that links its packages into `profiles/node_modules` may expose `dsh` through
 * a link Node cannot canonicalize, and the boot's module-fallback repair
 * realpaths exactly this directory. Taking the anchor from wherever the
 * profile's own base bundle resolves is both faithful (that IS the installation
 * providing the bundles) and link-proof.
 * @returns the absolute manifest path of the dsh app that owns this profile.
 */
function resolveInstallAnchor() {
  if (process.env.DSH_HARNESS_ANCHOR !== undefined) return resolve(process.env.DSH_HARNESS_ANCHOR)
  const candidates = []
  try {
    // <install>/packages/bundle/base/package.json -> <install>
    const base = realpathSync(join(libs, '@deepseek-ai/dsh-base/package.json'))
    candidates.push(join(base, '..', '..', '..', '..', 'apps', 'cli', 'package.json'))
  } catch {
    // Not a source checkout; fall through to the package entry.
  }
  try {
    candidates.push(realpathSync(join(libs, '@deepseek-ai/dsh/package.json')))
  } catch {
    // A self-referential link: nothing to fall back to.
  }
  const anchor = candidates.find(candidate => existsSync(candidate))
  if (anchor === undefined) {
    throw new Error('cannot locate the dsh installation anchor under ' + libs
      + '; set DSH_HARNESS_ANCHOR to the dsh app\'s package.json')
  }
  return anchor
}

const installAnchor = resolveInstallAnchor()

check('the dsh installation is where we think it is', existsSync(installAnchor), 'anchor=' + installAnchor)

// Load the profile the way the CLI does: every bundle layer, then the user layer.
const profile = appBoot.loadProfile('dsh', profileName, installAnchor, undefined, { userLayer: true })
await appBoot.healProfilesModuleFallback({ installAnchor, profile })
const homePatches = appBoot.loadOptionalPatches('dsh', join(homePaths.resolveDshHome(), appBoot.PROFILE_PATCH_FILENAME)) ?? []
const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches, ...homePatches]
const rootConfig = join(profile.dir, 'cordis.yml')

rmSync(INSIDE_TARGET, { force: true })
rmSync(DENIED_TARGET, { force: true })

// The web app's startup entry waits for `cmdlineArgs`, so the launcher-owned
// services must be provided before the tree mounts — exactly what the CLI's
// prepare hook does.
const environment = appBoot.loadLayeredEnv('dsh', process.cwd())
const ctx = await appBoot.boot('dsh', rootConfig, structuredClone(patches), (hostCtx) => {
  hostCtx.provide(launchEnvironment.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
  cmdline.provideCmdline(hostCtx, {
    args: [],
    exit: () => {},
    ready: { onReady: () => () => {} },
  })
})

try {
  check('sysctx.sandbox is this plugin provider'.replace('sys', ''), ctx.sandbox?.constructor?.name === 'MxcSandboxProvider',
    ctx.sandbox?.constructor?.name)
  check('the harness shell executor is mounted', typeof ctx.shell?.run === 'function')
  check('the sandbox policy service is mounted', typeof ctx.sandboxPolicy?.resolve === 'function')

  const policy = ctx.sandboxPolicy.resolve()
  check('the resolved policy is a confined mode', policy.mode === 'workspace-write' || policy.mode === 'read-only', policy.mode)

  // A foreground command through the real executor, confined by this plugin.
  const okRun = await ctx.shell.run(ctx.shell.resolve({ command: 'echo harness-mxc-ok' }))
  check('a command runs confined through the harness', okRun.exitCode === 0 && okRun.stdout.text.includes('harness-mxc-ok'),
    'exit=' + okRun.exitCode + ' stdout=' + JSON.stringify(okRun.stdout.text.trim()) + ' stderr=' + JSON.stringify(okRun.stderr.text.trim().slice(0, 120)))
  check('the result reports this backend enforcement', okRun.sandbox?.enforcement === 'partial', JSON.stringify(okRun.sandbox))
  check('a permitted command is not a denial', okRun.sandbox?.denied === false, JSON.stringify(okRun.sandbox))

  // A Node process inside the sandbox: module resolution lstats every parent
  // directory, which needs the workspace volume granted for reading. This is the
  // case that fails with EPERM when a workspace lives off the system drive.
  const nodeRun = await ctx.shell.run(ctx.shell.resolve({ command: 'node -e "console.log(1+1)"' }))
  check('a Node process runs inside the sandbox', nodeRun.exitCode === 0 && nodeRun.stdout.text.includes('2'),
    'exit=' + nodeRun.exitCode + ' stdout=' + JSON.stringify(nodeRun.stdout.text.trim().slice(0, 40))
      + ' stderr=' + JSON.stringify(nodeRun.stderr.text.trim().slice(0, 120)))

  // A write inside the workspace is permitted.
  // PowerShell syntax on purpose: the harness's Windows shell tool IS pwsh, and
  // `echo x> file` is not a redirection there (`>` must be its own token).
  const writeInside = await ctx.shell.run(ctx.shell.resolve({ command: "Set-Content -Path '" + INSIDE_TARGET + "' -Value inside" }))
  let insideContent
  try { insideContent = readFileSync(INSIDE_TARGET, 'utf8').trim() } catch { insideContent = undefined }
  check('a workspace write is permitted', writeInside.exitCode === 0 && insideContent === 'inside',
    'exit=' + writeInside.exitCode + ' content=' + JSON.stringify(insideContent))

  // A write outside the workspace is denied, and the harness must see a denial.
  const writeOutside = await ctx.shell.run(ctx.shell.resolve({ command: "Set-Content -Path '" + DENIED_TARGET + "' -Value escaped" }))
  check('an outside write is denied', writeOutside.exitCode !== 0 && !existsSync(DENIED_TARGET),
    'exit=' + writeOutside.exitCode + ' file=' + existsSync(DENIED_TARGET))
  check('the harness classifies it as a denial', writeOutside.sandbox?.denied === true,
    JSON.stringify(writeOutside.sandbox) + ' stderr=' + JSON.stringify(writeOutside.stderr.text.trim().slice(0, 80)))
  check('the harness does not call it a runner failure', writeOutside.sandbox?.runnerFailed === undefined,
    JSON.stringify(writeOutside.sandbox))

  // Control: the same write, unconfined, succeeds — the denial above is policy.
  rmSync(DENIED_TARGET, { force: true })
  const control = spawnSync('pwsh', ['-NoProfile', '-Command', "Set-Content -Path '" + DENIED_TARGET + "' -Value control"], { encoding: 'utf8', cwd: workspace })
  check('the same write succeeds unconfined (control)', control.status === 0 && existsSync(DENIED_TARGET), 'exit=' + control.status)
} finally {
  rmSync(INSIDE_TARGET, { force: true })
  rmSync(DENIED_TARGET, { force: true })
  await ctx.fiber.dispose()
}

if (failures.length > 0) {
  process.stderr.write('\n' + failures.length + ' harness case(s) failed\n')
  process.exit(1)
}
process.stdout.write('\nall harness cases passed (profile ' + profileName + ')\n')
process.exit(0)
