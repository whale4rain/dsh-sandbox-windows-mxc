English | [中文](README.zh.md)

# dsh-sandbox-windows-mxc

## Summary

`dsh-sandbox-windows-mxc` confines commands and their descendants on Windows by handing them to Microsoft's **eXecution Container (MXC)**: MXC applies the file policy, the contained process runs under MXC's ProcessContainer backend, and the wrapped command's exit status is mirrored back to the harness. The plugin occupies the DeepSeek Harness process-sandbox seam (`ctx.sandbox`) in place of `@deepseek-ai/dsh-sandbox-local`'s Windows ACL restricted-token rung.

Choose it when you want Windows confinement that is policy-driven by a host sandbox engine rather than by the harness's own DACL mutation: MXC owns the containment tiers, the AppContainer/BaseContainer selection, and denial capture, while the harness stays a pure consumer. The trade is a heavier dependency (a native MXC payload and a Windows 11 24H2+ floor) and read grants the harness must write explicitly, because MXC's AppContainer tiers have no ambient read access.

Every confined execution reports `enforcement: 'partial'` and fails closed: a command is never run unconfined.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [How a mode becomes an MXC request](#how-a-mode-becomes-an-mxc-request)
- [Failures and recovery](#failures-and-recovery)
- [Understand the implementation](#understand-the-implementation)
- [Verification](#verification)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Requirements

| Requirement | Detail |
|---|---|
| Host | Windows 11 **24H2 (build 26100)** or newer — MXC's ProcessContainer floor. Newer releases add MXC's base-container tier, which confines less (see the limitations below). |
| MXC executor | `wxc-exec.exe`, resolved from the `@microsoft/mxc-sdk` package payload (`bin/<arch>/wxc-exec.exe`), from `DSH_MXC_EXEC`, or from this plugin's `execPath`. |
| MXC contract | An executor whose supported contract range includes `contractVersion` (default `1.0.0`). MXC version-checks every request, and **`@microsoft/mxc-sdk`'s registry `latest` is not always 1.0.0**: an SDK 0.8.0 executor supports `>=0.6, <=0.9` and refuses a `1.0.0` request outright. This plugin speaks one exact contract at a time, so pin `contractVersion` to what your executor supports, or upgrade the SDK. |
| Node | 22.6 or newer (provider and runner are ESM-only). |

Install the SDK into the profile, or point `DSH_MXC_EXEC` at an executor you obtained another way — and check which contract that build speaks before the first command:

```bash
npm install @microsoft/mxc-sdk
wxc-exec.exe --probe    # tier and warnings, without spawning a sandbox
```

### Mounting it

The package ships a bundle patch, so installation through the plugin manager wires everything: the patch disables the shipped Windows ACL row on Windows and inserts this plugin, keeping exactly one `ctx.sandbox` provider.

```yaml
# dsh-sandbox-windows-mxc/cordis.patch.yml (shipped, abridged)
- id: sandbox
  disabled: !!js process.platform === 'win32'

- insert:
    - id: sandbox-mxc
      name: dsh-sandbox-windows-mxc
      disabled: !!js process.platform !== 'win32'
```

Every other platform keeps the shipped backend and leaves this row disabled. Do not mount both rows at once: the seam admits one `ctx.sandbox` provider, and the second registration fails.

### Minimal configuration

No configuration is required beyond the executor being resolvable.

```yaml
- id: sandbox-mxc
  name: dsh-sandbox-windows-mxc
  config:
    readOnlyRoots:
      - 'C:\Program Files\nodejs'
```

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `execPath` | unset | The MXC executor to invoke. Omit it to resolve `@microsoft/mxc-sdk`'s payload for this architecture (falling back to the other shipped architecture), or to use `DSH_MXC_EXEC`. A configured path that does not exist fails closed at the first confined command. |
| `containment` | 'processcontainer' | MXC's containment selection. 'process' lets MXC resolve the host's native process backend itself; 'processcontainer' pins the Windows ProcessContainer backend. |
| `readOnlyRoots` | [] | Extra directories a confined command may READ (never write). MXC's AppContainer tiers have no ambient read access, so anything outside the workspace an ordinary command must read — a toolchain, a package cache, a credential store — belongs here. The workspace itself is always readable. |
| `deniedPaths` | [] | Paths MXC denies outright. Enforcement is backend-dependent; a denial is reported through the sandbox facts. |
| `contractVersion` | '1.0.0' | The exact MXC contract every request carries. Set it to a version your executor supports (`0.9.0-alpha` for an `@microsoft/mxc-sdk` 0.8.x payload); MXC refuses a request outside its supported range, and this plugin verifies acceptance up front (see below). |
| `network` | 'allow' | 'allow' keeps the network exactly as an unconfined command would have it, because the sandbox seam's modes govern file effects only. 'deny' opts into MXC's egress/ingress denial, a stronger posture than the seam promises. |
| `ui` | 'allow' | Whether the desktop stays reachable. **`deny` is MXC's own default and it breaks the harness's Windows shell tool**: Windows programs need Win32k to initialize, so PowerShell (and Node) die with `STATUS_DLL_INIT_FAILED` (0xC0000142) before running anything — observed directly. `allow` keeps the desktop as unconfined, matching the shipped Windows rung; `deny` opts into MXC's UI denial and then only programs that never touch the UI subsystem can run. |
| `clipboard` | 'none' | Clipboard access for a contained command, when `ui: allow`: `none`, `read`, `write`, or `all`. |
| `allowInputInjection` | false | Whether synthetic keyboard and mouse input is permitted, when `ui: allow`. |
| `environment` | 'child' | 'child' gives the contained command exactly the environment the harness assembled (already scrubbed by the subprocess service). 'child+profile' additionally layers that block over the calling user's Windows profile environment, which is how profile-scoped variables (and the platform variables MXC requires) are reached. |
| `allowDaclMutation` | true | Whether MXC may write host filesystem DACLs as its fallback containment step. false refuses the fallback, so a tier that needs it fails instead of mutating host ACLs. |
| `clearPolicyOnExit` | true | true revokes the ACLs MXC applied for that one command. false keeps them (MXC's reuse cache), leaving standing host state behind. |
| `denialReport` | unset | Path for MXC's denial-capture report. Requires `containment: processcontainer`. Capture runs in block mode: denials are recorded AND still denied. |
| `retainEtl` | false | Keep MXC's sealed ETL trace next to the report. Requires `denialReport`; a retained trace can contain sensitive paths. |
| `denialSignatures` | [] | Extra case-insensitive stderr substrings that mean "denied" for this deployment. Rarely needed: the dialect is derived from the host already; use it for an in-house runner message or a locale this plugin could not read. |
| `mxcArgs` | [] | Extra arguments passed to the executor ahead of the request file, e.g. ['--debug'] for MXC's diagnostic console. |

Unknown fields are refused when the plugin mounts, so a typo names itself instead of silently taking a default.

-----

<a id="how-a-mode-becomes-an-mxc-request"></a>
## How a mode becomes an MXC request

The seam's two confined modes are file-effect policies, and each becomes one MXC `1.0.0` request. No execution timeout is sent: the harness's shell executor owns command deadlines, and a second deadline would report a timeout as an MXC outcome.

| Request field | read-only | workspace-write |
|---|---|---|
| `filesystem.readwritePaths` | [] — nothing is writable | [workspaceRoot, private temp dir] |
| `filesystem.readonlyPaths` | [workspaceRoot, ...readOnlyRoots] | [...readOnlyRoots] |
| `filesystem.deniedPaths` | deniedPaths | deniedPaths |
| `process.env` | the harness's environment, with its launch marker withheld | the same, with TMP/TEMP pointed at the private temp directory |
| `process.cwd` | the caller's working directory, always explicit | the same |
| `network` | config.network (an explicit posture; omission would mean deny) | the same |
| `ui` | { disable, clipboard, injection } — stated explicitly, because MXC's own default is `disable: true` | the same |
| `lifecycle` | { destroyOnExit: true, preservePolicy: !clearPolicyOnExit } | the same |
| `fallback` | { allowDaclMutation } | the same |
| `containerId` | dsh-&lt;sha256(workspace, session)[0..24]&gt; | the same |
| `version` | `config.contractVersion` (default `1.0.0`) | the same |

The private temp directory is created by the runner inside that call's ambient temp root, is granted read-write, is published as TMP/TEMP, and is removed afterwards. A temp root that IS the workspace or lives inside it is refused before any launch, because the two grants would otherwise be indistinguishable.

For a diagnosis, add `--print-config` to a runner invocation to see the exact request a wrapped argv would produce without running anything.

-----

<a id="failures-and-recovery"></a>
## Failures and recovery

Three outcomes stay distinct, because only one of them is a task failure:

| Outcome | How it surfaces |
|---|---|
| The command ran and a file effect was denied | the consumer's denial facts, matched against this backend's dialect: the static English wordings plus the host's own wording for `ERROR_ACCESS_DENIED` in both readings a child can produce |
| The command ran and failed on its own | an ordinary non-zero exit |
| The sandbox never ran the command | `SandboxUnavailableError` with code `SANDBOX_UNAVAILABLE`, carrying the runner's own reason |

A runner-side failure prints `mxc-sandbox-run: <detail>` on stderr and exits `127`. The wrapped command's output is never rewritten, so the consumer classifies with both the exit status and that signature.

MXC-side refusals reach the consumer through two routes, because MXC expresses them two ways:

- **Before anything runs**: the provider verifies, once per provider, that the executor accepts the request this call would send, by handing it to `wxc-exec.exe --dry-run` (parse and validate, then exit). A refusal throws `SANDBOX_UNAVAILABLE` at `confine()` with MXC's own text — the case an operator hits after installing an SDK whose contract differs from `contractVersion`. An executor without a dry run yields no verdict at all, so the probe can never fail-close a working backend.
- **While running**: a refusal MXC reports as its JSON error envelope on the last stderr line is converted into the same `127` + signature vocabulary, and the raw envelope stays in stderr for the operator.

| Detail seen | Fix |
|---|---|
| execPath does not exist / cannot resolve @microsoft/mxc-sdk | install the SDK, set `execPath`, or set `DSH_MXC_EXEC` |
| MXC refused the request (backend_unavailable) | the host is below MXC's ProcessContainer floor or the tier is unavailable; check `wxc-exec.exe --probe` |
| the installed MXC executor refuses this request: Config schema version … is newer than supported | the SDK's contract differs from `contractVersion`; pin `contractVersion` to a supported version or upgrade `wxc-exec` |
| --temp is not an existing directory | the harness passed an ambient temp root that does not exist on this host |
| --workspace is not an existing directory | the session's working directory was removed (or is a dangling junction) before the command ran |
| MXC refuses an explicit environment without … | set `environment: child+profile` so MXC can supply the platform-required variables |
| a confined command cannot read its own toolchain | add that directory to `readOnlyRoots` |
| `EPERM: operation not permitted, lstat 'D:\'` from any Node process in the sandbox | the workspace lives on a non-system volume whose root is not readable inside the container, and Node's module resolution lstats every parent directory. Grant it (`readOnlyRoots: ['D:\\']`) or run `wxc-host-prep prepare-system-drive --target D:\` once (elevated; adds one non-inheriting read-attributes ACE). |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Two halves, one contract:

- **`index.js` — the provider** resolves the policy, locates the executor, derives the container id, and returns the wrapped argv plus the enforcement, denial, and runner-failure facts. It holds no host state and applies nothing, and it refuses to run off Windows.
- **`runner.js` — the runner** is a standalone Node entry the provider spawns. It re-validates its own arguments, derives the MXC request (`src/policy.js`), quotes the caller's argv back into a command line (`src/quote.js`), writes the request to a private scratch file, spawns the executor with the caller's stdin/stdout inherited and stderr piped, mirrors the exit status, and removes its scratch and private temp directories.

The argv dialect (`src/argv.js`) is the whole interface between the two halves, spelled as flags so that a wrapped command's argv is its own diagnosis. The runner deliberately imports no harness package: it must start under the profile's Node even when the profile's module graph is unusual.

The runner refuses the harness's subprocess control marker rather than quietly dropping it. That channel is an inherited descriptor at fd 7, while MXC's executor contract is a JSON request file plus MXC-owned stdio, so the descriptor cannot be handed through. A confined PTC call therefore fails closed with a named reason instead of silently losing its channel; everything that spawns through `ctx.shell` is unaffected.

-----

<a id="verification"></a>
## Verification

```bash
npm install
npm test
```

`node tests/run.js` imports every suite into one process, so the suites run even where the host refuses to fork extra children; `node tests/run.js runner` selects one file.

| Suite | What it pins |
|---|---|
| tests/quote.test.js | Windows command-line quoting against an independently written parser: quotes, trailing backslashes, empty arguments, tabs, newlines, unicode |
| tests/config.test.js | every default, and that a malformed row names its field and its accepted values |
| tests/policy.test.js | the mode→request mapping, the per-call lifecycle, the container-id derivation, the child environment |
| tests/argv.test.js | that build and parse agree over a fully-specified argv, and that a malformed one fails closed |
| tests/classify.test.js | the enforcement report, the denial dialect, the runner-failure rule, and the MXC envelope recognizer |
| tests/paths.test.js | canonical containment checks, including a real NTFS junction |
| tests/locate.test.js | executor resolution order (execPath → DSH_MXC_EXEC → SDK payload → architecture fallback) and the runner-entry fallback |
| tests/provider.test.js | the provider mounted on the real @deepseek-ai/dsh-sandbox seam: wrapped argv, per-config argv, session-scoped container ids, every fail-closed path |
| tests/runner.test.js | the runner end to end against a stub executor: request contents, environment, private-temp lifecycle, output relay, exit mirroring, envelope classification, the temp-root guard, the control-marker refusal, `--print-config` |
| tests/live/harness.mjs | a booted real dsh profile: `ctx.sandbox` is this provider, `ctx.shell` runs a confined command through it, a workspace write is permitted, an outside write is denied and classified as a denial by the harness |
| tests/denial.test.js | the host-derived denial dialect: both readings of a real zh-CN host's bytes, the ASCII-host dedupe, and every fail-soft path |
| tests/contract.test.js | the up-front contract verification: acceptance, a refusal carrying MXC's own last line, an executor without a dry run yielding no verdict, and scratch-file cleanup |
| tests/manifest.test.js | the bundle patch, the exports and files lists, the display metadata in both locales, and the icon |

### Live acceptance

```bash
npm run acceptance              # the provider against a real executor; DSH_MXC_EXEC pins one
npm run acceptance:harness      # boot a real dsh profile and drive its own shell tool
```

`tests/live/acceptance.mjs` mounts the provider on the real seam, confines an argv, spawns exactly what `confine()` returned, and asserts five facts. **Observed on a Windows 11 25H2 host (build 26200.9457) with the `@microsoft/mxc-sdk` 0.8.0 payload, pinned to its `0.9.0-alpha` contract:**

| Case | Observation |
|---|---|
| read-only `cmd /c echo …` | ran, exit 0, output relayed byte for byte; `enforcement: 'partial'` as reported |
| a Node grandchild with piped stdio, plus a named pipe it creates and opens itself | all four patterns succeed (`inherit`, `node-pipe`, `cmd-pipe`, `named-pipe`) — the EPERM class the ACL backend documents as impossible does not reproduce on this tier |
| workspace-write, write inside the workspace | allowed, exit 0, file created with the expected content |
| workspace-write, write outside the workspace | denied, exit 1, **no file created** |
| the same write, unconfined (control) | succeeded — so the denial above is the sandbox's policy, not a host permission |
| the denial the consumer sees | matched by the dialect's host-derived reading (the harness decodes the child's OEM-encoded stderr as UTF-8, which is why the byte-level reading exists) |
| `contractVersion: 1.0.0` against that executor | `SANDBOX_UNAVAILABLE` before anything ran, carrying MXC's own "Config schema version '1.0.0' is newer than supported (supported: >=0.6, <=0.9)" |

`wxc-exec.exe --probe` on that host reports `tier: "base-container"`, `baseContainerApiPresent: true`, `needsDaclAugmentation: false`, `isolationSessionAvailable: false` — MXC's newest tier, which needs no host DACL mutation.

### Installed in a real dsh, through the harness's own shell tool

```bash
npm run acceptance:harness          # DSH_HARNESS_PROFILE selects the profile (default web)
```

`tests/live/harness.mjs` loads a real profile the way the CLI does (every bundle layer, then the profile's own patch file), boots the tree, and asserts on the live services rather than on this plugin's own output. **Observed on the web profile of the dsh 0.1.5-rc.2 installation at `D:\task\deepseek-harness`, with the plugin installed as a live link:**

| Case | Observation |
|---|---|
| `ctx.sandbox` | **`MxcSandboxProvider`** — this plugin is the mounted provider, and the shipped ACL row is disabled by the bundle patch |
| `ctx.shell` (the real `dsh-pwsh-sandbox`) | runs a foreground command confined, exit 0, output relayed: `echo harness-mxc-ok` |
| the result's sandbox facts | `{ mode: 'workspace-write', denied: false, enforcement: 'partial' }` |
| a Node process (`node -e "console.log(1+1)"`) | ran inside the sandbox, exit 0 — module resolution passed, which needs the workspace volume granted |
| `Set-Content` inside the workspace | permitted, file created with the expected content |
| `Set-Content` outside the workspace | denied (exit 1, no file), stderr `Access to the path '…' is denied.` |
| the harness's own classification | `denied: true`, and **not** reported as a runner failure |
| the same write, unconfined (control) | succeeded — the denial is policy, not host permission |

**The one finding that changes the defaults:** with MXC's own `ui.disable: true`, PowerShell — the harness's Windows shell tool — dies with `STATUS_DLL_INIT_FAILED` (0xC0000142) before executing anything, because it needs Win32k to initialize; Node does the same. Confirmed both ways: the same `pwsh` command under MXC exits `-1073741502` without UI access and `0` with it. The plugin therefore defaults to `ui: allow` (the desktop left as unconfined, like the shipped Windows rung) instead of MXC's `deny`. An operator who wants the harder posture sets `ui: deny` and accepts that only non-UI programs can run.

### What is not verified yet

- **The `1.0.0` contract has not been exercised end to end**: no SDK build shipping a `1.0.0` executor was available on the acceptance host, so the field-by-field match against MXC's published `1.0.0` schema rests on the schema and the docs. Everything above ran under `0.9.0-alpha`.
- **The escalation and approval path is still untested**: the harness's tool layer was driven (`npm run acceptance:harness`), but only with permits it already had. A command that needs an approval prompt, the escalation retry into `danger-full-access`, and the rendering of a denial in the Web UI have not been exercised.
- **The Electron desktop profile is not tested**: the dsh CLI refuses to manage it ("profile desktop is managed exclusively by the Electron application"), so this was installed into a CLI-managed profile only.
- **Other backends and diagnostics**: `wslc`, `windows_sandbox`, `isolation_session` (its service exists on this host but the probe reports it unavailable), `--audit` mode, and the denial-report artifact are untouched by this plugin's tested paths.
- **Localized denial wording is verified for exactly one locale** (zh-CN, which this host is). Other locales rely on the same derivation, which is locale-independent by construction, but only zh-CN has been observed.

The runner suites spawn child processes; on a host (or inside a sandbox) that forbids forking, they fail with a spawn error rather than a plugin defect. The live acceptance needs a real executor and is not part of `npm test`.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- **Enforcement is always reported partial.** NTFS hard links alias one file object across paths, so a granted workspace file still has an address outside the granted root; a tree whose DACL names another sandbox's AppContainer package SID cannot be opened by the confined child; the selected tier is host-dependent (MXC's base-container tier on newer releases keeps the caller's ambient reads instead of confining them); and denial capture in allow mode would record while permitting. A consumer that needs an absolute boundary must reject this backend rather than treat it as full.
- **Reads are granted explicitly, because a tier may need it.** MXC's AppContainer tiers start with no ambient read access, so the workspace and every `readOnlyRoots` entry are granted for reading; on the base-container tier reads are ambient and the grant is redundant but harmless. The grant is why `readOnlyRoots` should name directories rather than whole drives.
- **Piped stdio and named pipes work on the base-container tier — and that is a tier fact, not a guarantee.** The harness's ACL backend documents the opposite: libuv's pipe stdio uses named pipes whose client-end open requests write access no restricting SID is granted, so `spawn(…, { stdio: 'pipe' })` inside a confined process fails with `EPERM`. Under MXC on this project's host (`tier: base-container`, which keeps the caller's identity for object access rather than swapping it) that failure does not reproduce: an inherited-stdio spawn, a piped Node grandchild, a piped `cmd`, and a named pipe the confined process creates and opens itself all succeed — pinned by `npm run acceptance`. On an AppContainer/DACL tier the identity IS swapped, so the same class of denial may well return; that path is unverified here.
- **The workspace needs host-side ACL application** on the AppContainer tiers, which MXC performs per command and then revokes (`clearPolicyOnExit: true`); `allowDaclMutation: false` refuses that fallback, at the cost of the tiers that need it.
- **The desktop stays reachable by default.** `ui: allow` is the default because Windows programs (PowerShell and Node among them) cannot initialize without Win32k; clipboard access is still `none` and input injection is still denied. `ui: deny` gives MXC's harder posture, at the cost of every program that touches the UI subsystem.
- **No interactive terminal.** MXC's one-shot executor owns the process's stdio; this plugin forwards the caller's stdio but does not implement a PTY. The harness's PTY-backed terminal tools do not go through `ctx.sandbox` and are unaffected.
- **The MXC request carries the child's environment** — that is how TMP/TEMP reach the granted private directory — so it holds whatever credentials the profile provides. The runner writes it to the system temp root for the duration of one command and deletes it, and `--print-config` prints the same content (with a stderr note) for diagnosis. Treat both as sensitive, and treat a temp root shared with other local users as shared with them.
- **The subprocess control channel is refused**, not forwarded (see above). Keep `@deepseek-ai/dsh-sandbox-local` if a profile depends on sandboxed PTC execution.
- **One exact contract at a time.** MXC version-checks every request and refuses anything outside what the executor supports; this plugin sends `contractVersion` and nothing else. The up-front `--dry-run` verification turns that refusal into `SANDBOX_UNAVAILABLE` before anything runs, so a version mismatch is a fail-closed sandbox rather than silent under-confinement — but it also means an SDK whose contract the plugin does not speak yet needs `contractVersion` set (or a plugin update), not a fallback.
- **Deferred:** the `1.1.0-alpha` contract (per-command leastPrivilege, enumeratePaths), surfacing MXC's probe output through a tool or an inspect provider, the `wslc`/`isolation_session` boundaries (which are whole-capability replacements, not sandbox rungs), and a profile-level acceptance run through the harness's own bash/pwsh tool layer.

-----

<a id="dev-note"></a>
## Dev note

<details>
<summary>Maintainer context — click to expand</summary>

- **Why not reuse the shipped ACL rung?** The harness already ships `@deepseek-ai/dsh-sandbox-windows-acl`; this plugin exists because MXC is a different trade — Microsoft-maintained and policy-driven, at the cost of a native payload, a 24H2+ floor, and mandatory read grants. The two are alternatives for one seam, never complements.
- **Where the truth lives:** `src/policy.js` is the single place a mode becomes a request, `src/denial.js` the single place the denial dialect is derived, `src/contract.js` the single place the executor's acceptance is judged, and `tests/policy.test.js`, `tests/denial.test.js`, `tests/contract.test.js` are where each is pinned. The runner adds no policy of its own beyond re-validating what it was handed.
- **Adding a config field** means four edits: the key list and validation in `src/config.js`, the mapping in `src/policy.js`, a flag in `src/argv.js` (both build and parse), and the table above. `tests/argv.test.js` proves the two halves agree.
- **Why a runner at all?** The seam hands over an argv; MXC wants a JSON request. That shape change cannot be expressed *as* an argv, so one process must translate — and MXC's `wxc-exec <config> -- <command>` override does not remove the need, it only moves the command out of the file: something still has to write a per-call request (the policy differs per call: mode, workspace, temp root, session id) and delete it afterwards. The runner owns exactly that, plus three things the alternatives would lose: `stderr` is piped so MXC's error envelope becomes the seam's `127` + signature (otherwise "the sandbox refused" and "the command failed" look identical), the private temp directory is created and removed per call (the provider stays stateless), and the command line is quoted here (`src/quote.js`) rather than by MXC from argv, so the quoting rules are the documented `CommandLineToArgvW` ones and are tested. `node tests/live/chain.mjs` prints the whole four-layer chain for one command.
- **Do not import harness packages into the runner.** It runs under the profile's Node with the profile's environment; its only imports are Node builtins and its own `src/` modules.

</details>
