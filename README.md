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
| Node | 22.6 or newer (provider and runner are ESM-only). |

Install the SDK into the profile, or point `DSH_MXC_EXEC` at an executor you obtained another way:

```bash
npm install @microsoft/mxc-sdk
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
| `network` | 'allow' | 'allow' keeps the network exactly as an unconfined command would have it, because the sandbox seam's modes govern file effects only. 'deny' opts into MXC's egress/ingress denial, a stronger posture than the seam promises. |
| `environment` | 'child' | 'child' gives the contained command exactly the environment the harness assembled (already scrubbed by the subprocess service). 'child+profile' additionally layers that block over the calling user's Windows profile environment, which is how profile-scoped variables (and the platform variables MXC requires) are reached. |
| `allowDaclMutation` | true | Whether MXC may write host filesystem DACLs as its fallback containment step. false refuses the fallback, so a tier that needs it fails instead of mutating host ACLs. |
| `clearPolicyOnExit` | true | true revokes the ACLs MXC applied for that one command. false keeps them (MXC's reuse cache), leaving standing host state behind. |
| `denialReport` | unset | Path for MXC's denial-capture report. Requires `containment: processcontainer`. Capture runs in block mode: denials are recorded AND still denied. |
| `retainEtl` | false | Keep MXC's sealed ETL trace next to the report. Requires `denialReport`; a retained trace can contain sensitive paths. |
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
| `lifecycle` | { destroyOnExit: true, preservePolicy: !clearPolicyOnExit } | the same |
| `fallback` | { allowDaclMutation } | the same |
| `containerId` | dsh-&lt;sha256(workspace, session)[0..24]&gt; | the same |

The private temp directory is created by the runner inside that call's ambient temp root, is granted read-write, is published as TMP/TEMP, and is removed afterwards. A temp root that IS the workspace or lives inside it is refused before any launch, because the two grants would otherwise be indistinguishable.

For a diagnosis, add `--print-config` to a runner invocation to see the exact request a wrapped argv would produce without running anything.

-----

<a id="failures-and-recovery"></a>
## Failures and recovery

Three outcomes stay distinct, because only one of them is a task failure:

| Outcome | How it surfaces |
|---|---|
| The command ran and a file effect was denied | the consumer's denial facts, derived from this backend's denial dialect ("Access is denied.", "Access to the path … is denied.", EACCES/EPERM wordings) |
| The command ran and failed on its own | an ordinary non-zero exit |
| The sandbox never ran the command | `SandboxUnavailableError` with code `SANDBOX_UNAVAILABLE`, carrying the runner's own reason |

A runner-side failure prints `mxc-sandbox-run: <detail>` on stderr and exits `127`. The wrapped command's output is never rewritten, so the consumer classifies with both the exit status and that signature. Every MXC-side refusal (unsupported containment, no usable backend, a rejected policy) arrives as MXC's JSON error envelope on the last stderr line, is converted into the same runner-failure vocabulary, and is left in stderr unchanged for the operator.

| Detail seen | Fix |
|---|---|
| execPath does not exist / cannot resolve @microsoft/mxc-sdk | install the SDK, set `execPath`, or set `DSH_MXC_EXEC` |
| MXC refused the request (backend_unavailable) | the host is below MXC's ProcessContainer floor or the tier is unavailable; check `wxc-exec.exe --probe` |
| --temp is not an existing directory | the harness passed an ambient temp root that does not exist on this host |
| --workspace is not an existing directory | the session's working directory was removed (or is a dangling junction) before the command ran |
| MXC refuses an explicit environment without … | set `environment: child+profile` so MXC can supply the platform-required variables |
| a confined command cannot read its own toolchain | add that directory to `readOnlyRoots` |

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
| tests/manifest.test.js | the bundle patch, the exports and files lists, the display metadata in both locales, and the icon |

### What is not verified yet

No MXC payload was present on the machine this plugin was developed on, so **the launch path has not been exercised against a real `wxc-exec.exe`** and no live containment assertion has been observed. What is verified is this plugin's own contract: the request document matches MXC's published `1.0.0` schema field by field, the quoting survives an independently written command-line parser, and the failure vocabulary matches the documented executor behavior (exit-status mirroring and the stderr error envelope). Before relying on it, run these two live checks on a Windows 11 24H2+ host:

```powershell
# 1. Which containment tier will this host actually give you?
& "<sdk>\bin\x64\wxc-exec.exe" --probe

# 2. Inspect the exact request one real command would run under.
node runner.js --workspace $PWD --mode read-only --exec "<sdk>\bin\x64\wxc-exec.exe" --print-config -- cmd /c "echo hello"
```

Then drop `--print-config` and confirm the two facts the harness renders: a write outside the workspace is reported as a denial (not a task failure), and an unusable executor surfaces as `SANDBOX_UNAVAILABLE`.

The runner suites spawn child processes; on a host (or inside a sandbox) that forbids forking, they fail with a spawn error rather than a plugin defect.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- **Enforcement is always reported partial.** NTFS hard links alias one file object across paths, so a granted workspace file still has an address outside the granted root; a tree whose DACL names another sandbox's AppContainer package SID cannot be opened by the confined child; the selected tier is host-dependent (MXC's base-container tier on newer releases keeps the caller's ambient reads instead of confining them); and denial capture in allow mode would record while permitting. A consumer that needs an absolute boundary must reject this backend rather than treat it as full.
- **Reads are granted explicitly.** MXC's AppContainer tiers start with no ambient read access, so the workspace and every `readOnlyRoots` entry are granted for reading. That is a wider surface than a read-unconfined backend, and the reason `readOnlyRoots` should name directories rather than whole drives.
- **The workspace needs host-side ACL application** on the AppContainer tiers, which MXC performs per command and then revokes (`clearPolicyOnExit: true`); `allowDaclMutation: false` refuses that fallback, at the cost of the tiers that need it.
- **No interactive terminal.** MXC's one-shot executor owns the process's stdio; this plugin forwards the caller's stdio but does not implement a PTY. The harness's PTY-backed terminal tools do not go through `ctx.sandbox` and are unaffected.
- **The MXC request carries the child's environment** — that is how TMP/TEMP reach the granted private directory — so it holds whatever credentials the profile provides. The runner writes it to the system temp root for the duration of one command and deletes it, and `--print-config` prints the same content (with a stderr note) for diagnosis. Treat both as sensitive, and treat a temp root shared with other local users as shared with them.
- **The subprocess control channel is refused**, not forwarded (see above). Keep `@deepseek-ai/dsh-sandbox-local` if a profile depends on sandboxed PTC execution.
- **Version skew is not detected at runtime.** This plugin speaks the exact `1.0.0` contract. MXC rejects an unknown or unsupported request instead of partially applying it, and the runner converts that rejection into `SANDBOX_UNAVAILABLE`, so a future contract shows up as a fail-closed sandbox rather than as silent under-confinement.
- **Deferred:** the `1.1.0-alpha` contract (per-command leastPrivilege, enumeratePaths), surfacing MXC's probe output through a tool or an inspect provider, and a live-host acceptance suite.

-----

<a id="dev-note"></a>
## Dev note

<details>
<summary>Maintainer context — click to expand</summary>

- **Why not reuse the shipped ACL rung?** The harness already ships `@deepseek-ai/dsh-sandbox-windows-acl`; this plugin exists because MXC is a different trade — Microsoft-maintained and policy-driven, at the cost of a native payload, a 24H2+ floor, and mandatory read grants. The two are alternatives for one seam, never complements.
- **Where the truth lives:** `src/policy.js` is the single place a mode becomes a request, and `tests/policy.test.js` is where it is pinned. The runner adds no policy of its own beyond re-validating what it was handed.
- **Adding a config field** means four edits: the key list and validation in `src/config.js`, the mapping in `src/policy.js`, a flag in `src/argv.js` (both build and parse), and the table above. `tests/argv.test.js` proves the two halves agree.
- **Do not import harness packages into the runner.** It runs under the profile's Node with the profile's environment; its only imports are Node builtins and its own `src/` modules.

</details>
