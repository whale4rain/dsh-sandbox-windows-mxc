/**
 * Where the MXC executor and this plugin's runner live.
 *
 * The executor is a native binary, so its location is an operator fact, not a
 * guess: an explicit configuration wins, then the documented environment
 * variable, then the `@microsoft/mxc-sdk` package payload. Nothing is
 * improvised — a missing binary must fail closed, never run a command
 * unconfined.
 *
 * @module dsh-sandbox-windows-mxc/locate
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The SDK that ships the MXC native payload. */
export const SDK_PACKAGE = '@microsoft/mxc-sdk'

/** The environment variable an operator can point at an explicit executor. */
export const EXEC_ENVIRONMENT = 'DSH_MXC_EXEC'

/** The Windows one-shot executor inside the SDK's payload. */
export const EXEC_NAME = 'wxc-exec.exe'

/**
 * The architecture directories to try, most specific first.
 *
 * The SDK ships both x64 and arm64 payloads, and an emulated x64 Node process
 * on an arm64 host reports `x64` while a native arm64 Node reports `arm64`;
 * trying the other directory keeps a correctly installed SDK usable in both
 * cases. x64 is last because every Windows 11 on arm64 can run it.
 * @param arch - `process.arch`.
 * @returns the candidate directory names, deduplicated.
 */
export function architectureCandidates(arch) {
  return arch === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64']
}

/** Resolve the SDK manifest through this installation's module resolution. */
function defaultResolvePackageJson() {
  return fileURLToPath(import.meta.resolve(`${SDK_PACKAGE}/package.json`))
}

/** Resolve this package's own runner entry through its exports map. */
function defaultResolveRunner() {
  return import.meta.resolve('dsh-sandbox-windows-mxc/runner')
}

/**
 * Locate the MXC Windows executor.
 * @param options - resolution inputs; every one is injectable for tests.
 * @param options.configuredPath - the row's `execPath`, when set.
 * @param options.env - the environment consulted for {@link EXEC_ENVIRONMENT}.
 * @param options.arch - the architecture to prefer.
 * @param options.exists - file-existence predicate.
 * @param options.resolvePackageJson - resolver for the SDK manifest.
 * @returns the absolute executor path.
 * @throws Error naming every way to supply the executor when none resolves.
 */
export function locateMxcExec(options = {}) {
  const {
    configuredPath,
    env = process.env,
    arch = process.arch,
    exists = existsSync,
    resolvePackageJson = defaultResolvePackageJson,
  } = options
  if (configuredPath !== undefined) {
    if (!exists(configuredPath)) throw new Error(`execPath does not exist: ${configuredPath}`)
    return configuredPath
  }
  const fromEnvironment = env[EXEC_ENVIRONMENT]
  if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) {
    if (!exists(fromEnvironment)) throw new Error(`${EXEC_ENVIRONMENT} does not exist: ${fromEnvironment}`)
    return fromEnvironment
  }
  let manifest
  try {
    manifest = resolvePackageJson()
  } catch (error) {
    throw new Error(`cannot resolve ${SDK_PACKAGE} (${error instanceof Error ? error.message : String(error)}); install it, set execPath, or set ${EXEC_ENVIRONMENT}`)
  }
  const payloadRoot = dirname(manifest)
  for (const candidate of architectureCandidates(arch)) {
    const path = join(payloadRoot, 'bin', candidate, EXEC_NAME)
    if (exists(path)) return path
  }
  throw new Error(`${SDK_PACKAGE} at ${payloadRoot} ships no ${EXEC_NAME} for ${architectureCandidates(arch).join(' or ')}; reinstall the SDK, set execPath, or set ${EXEC_ENVIRONMENT}`)
}

/**
 * Locate this package's runner entry.
 *
 * Self-reference resolution needs the package to be importable by its own name
 * — a bundle linked into a profile from a directory whose manifest the loader
 * already read may not be — so the sibling entry is the fallback. Both name the
 * same module: the runner is spawned by path, not by specifier.
 * @param options - resolution inputs; every one is injectable for tests.
 * @param options.resolve - runner-entry specifier resolver.
 * @param options.selfUrl - this module's own URL, for the sibling fallback.
 * @param options.exists - file-existence predicate.
 * @returns the absolute runner entry path.
 */
export function locateRunnerEntry(options = {}) {
  const { resolve = defaultResolveRunner, selfUrl = import.meta.url, exists = existsSync } = options
  try {
    const resolved = resolve()
    if (typeof resolved === 'string' && resolved.length > 0) {
      const path = fileURLToPath(resolved)
      if (exists(path)) return path
    }
  } catch {
    // Fall through to the sibling entry.
  }
  return fileURLToPath(new URL('../runner.js', selfUrl))
}
