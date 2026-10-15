/**
 * Plugin configuration: defaults, validation, and the frozen shape every other
 * module consumes.
 *
 * Validation is explicit (no schema dependency) so a malformed row names the
 * field and the accepted values when the plugin mounts, instead of failing
 * inside a confined command.
 *
 * @module dsh-sandbox-windows-mxc/config
 */

/** The accepted `containment` values (MXC's Windows one-shot selection). */
export const CONTAINMENTS = Object.freeze(['processcontainer', 'process'])

/** The accepted `network` postures. */
export const NETWORK_POSTURES = Object.freeze(['allow', 'deny'])

/** The accepted `environment` modes. */
export const ENVIRONMENT_MODES = Object.freeze(['child', 'child+profile'])

/** Every accepted configuration key (typos are rejected, not ignored). */
export const CONFIG_KEYS = Object.freeze([
  'execPath',
  'contractVersion',
  'containment',
  'readOnlyRoots',
  'deniedPaths',
  'denialSignatures',
  'network',
  'environment',
  'allowDaclMutation',
  'clearPolicyOnExit',
  'denialReport',
  'retainEtl',
  'mxcArgs',
])

/** Throw with the plugin's name, so a profile log identifies the source row. */
function fail(message) {
  throw new Error(`dsh-sandbox-windows-mxc: ${message}`)
}

/** Require a non-empty string. */
function stringField(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${name} must be a non-empty string`)
  return value
}

/** Require an array of non-empty strings. */
function stringArrayField(name, value) {
  if (!Array.isArray(value)) fail(`${name} must be an array of strings`)
  for (const entry of value) stringField(`${name} entries`, entry)
  return [...value]
}

/** Require an MXC contract version spelling (e.g. `1.0.0`, `0.9.0-alpha`). */
function contractVersionField(value) {
  if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.]+)?$/u.test(value)) {
    fail('contractVersion must be an MXC contract version such as "1.0.0" or "0.9.0-alpha"; received ' + JSON.stringify(value))
  }
  return value
}

/** Require single-line stderr substrings. */
function signatureArrayField(name, value) {
  const entries = stringArrayField(name, value)
  for (const entry of entries) {
    if (/[\r\n]/u.test(entry)) fail(`${name} entries must be single-line strings`)
  }
  return entries
}

/** Require a boolean. */
function booleanField(name, value) {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`)
  return value
}

/** Require membership in a closed set. */
function enumField(name, value, accepted) {
  if (typeof value !== 'string' || !accepted.includes(value)) {
    fail(`${name} must be one of ${accepted.map(entry => JSON.stringify(entry)).join(', ')}; received ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate one configuration row and fill every default.
 *
 * Defaults are the shipped selection policy: MXC's Windows `processcontainer`
 * containment, the caller's own (already scrubbed) environment, network left
 * unrestricted because the sandbox seam's modes govern file effects only, host
 * DACL mutation permitted because the AppContainer tiers require it to grant
 * reads at all, and no policy preserved after the command — the per-call model,
 * with no standing host state.
 * @param raw - the row's `config` mapping, or undefined.
 * @returns the frozen normalized configuration.
 */
export function normalizeConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) fail('config must be a mapping')
  for (const key of Object.keys(source)) {
    if (!CONFIG_KEYS.includes(key)) fail(`unknown config field ${JSON.stringify(key)}; accepted fields are ${CONFIG_KEYS.join(', ')}`)
  }
  const containment = source.containment === undefined ? 'processcontainer' : enumField('containment', source.containment, CONTAINMENTS)
  const denialReport = source.denialReport === undefined ? undefined : stringField('denialReport', source.denialReport)
  const retainEtl = source.retainEtl === undefined ? false : booleanField('retainEtl', source.retainEtl)
  if (retainEtl && denialReport === undefined) fail('retainEtl requires denialReport')
  if (denialReport !== undefined && containment !== 'processcontainer') {
    fail('denialReport requires containment "processcontainer": the denial-capture policy lives in MXC\'s ProcessContainer section')
  }
  return Object.freeze({
    execPath: source.execPath === undefined ? undefined : stringField('execPath', source.execPath),
    contractVersion: source.contractVersion === undefined ? '1.0.0' : contractVersionField(source.contractVersion),
    containment,
    readOnlyRoots: source.readOnlyRoots === undefined ? Object.freeze([]) : Object.freeze(stringArrayField('readOnlyRoots', source.readOnlyRoots)),
    deniedPaths: source.deniedPaths === undefined ? Object.freeze([]) : Object.freeze(stringArrayField('deniedPaths', source.deniedPaths)),
    denialSignatures: source.denialSignatures === undefined ? Object.freeze([]) : Object.freeze(signatureArrayField('denialSignatures', source.denialSignatures)),
    network: source.network === undefined ? 'allow' : enumField('network', source.network, NETWORK_POSTURES),
    environment: source.environment === undefined ? 'child' : enumField('environment', source.environment, ENVIRONMENT_MODES),
    allowDaclMutation: source.allowDaclMutation === undefined ? true : booleanField('allowDaclMutation', source.allowDaclMutation),
    clearPolicyOnExit: source.clearPolicyOnExit === undefined ? true : booleanField('clearPolicyOnExit', source.clearPolicyOnExit),
    denialReport,
    retainEtl,
    mxcArgs: source.mxcArgs === undefined ? Object.freeze([]) : Object.freeze(stringArrayField('mxcArgs', source.mxcArgs)),
  })
}
