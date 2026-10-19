[English](README.md) | 中文

# dsh-sandbox-windows-mxc

## 概述

`dsh-sandbox-windows-mxc` 在 Windows 上把命令及其子进程交给微软的 **eXecution Container（MXC）** 执行：MXC 应用文件策略，被隔离的进程运行在 MXC 的 ProcessContainer 后端下，包装命令的退出码原样回传给 harness。本插件占据 DeepSeek Harness 的进程沙箱 seam（`ctx.sandbox`），替代 `@deepseek-ai/dsh-sandbox-local` 在 Windows 上的 ACL 受限令牌档位。

当你想让 Windows 隔离由宿主侧沙箱引擎按策略驱动、而不是由 harness 自己改写 DACL 时，选它：containment 档位、AppContainer/BaseContainer 的选择、拒绝记录都由 MXC 负责，harness 只是一名消费者。代价是更重的依赖（原生 MXC 载荷与 Windows 11 24H2+ 的系统下限），以及必须显式写入的读取授权——MXC 的 AppContainer 档位没有环境自带的读权限。

每次受限执行都上报 `enforcement 为 partial`，并且故障关闭：命令绝不会在无隔离的情况下运行。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模式如何变成 MXC 请求](#how-a-mode-becomes-an-mxc-request)
- [失败与恢复](#failures-and-recovery)
- [实现说明](#understand-the-implementation)
- [验证](#verification)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 环境要求

| 要求 | 说明 |
|---|---|
| 宿主 | Windows 11 **24H2（build 26100）** 或更高——这是 MXC ProcessContainer 的下限。更新的版本会引入 MXC 的 base-container 档位，其隔离强度更低（见下文限制）。 |
| MXC 执行器 | `wxc-exec.exe`，解析顺序为 `@microsoft/mxc-sdk` 包的载荷（`bin/<arch>/wxc-exec.exe`）、`DSH_MXC_EXEC`、本插件的 `execPath` 配置。 |
| MXC 契约 | 执行器支持的契约范围必须包含 `contractVersion`（默认 `1.0.0`）。MXC 会对每份请求做版本校验，而 **`@microsoft/mxc-sdk` 在 registry 上的 `latest` 并不总是 1.0.0**：0.8.0 的执行器支持 `>=0.6, <=0.9`，会直接拒绝 `1.0.0` 请求。本插件一次只说一份精确契约，所以要么把 `contractVersion` 钉到执行器支持的版本，要么升级 SDK。 |
| Node | 22.6 或更高（provider 与 runner 只用 ESM）。 |

把 SDK 装进当前 profile（或用 `DSH_MXC_EXEC` 指向你以其他方式取得的执行器）：

```bash
npm install @microsoft/mxc-sdk
```

### 挂载

本包自带 bundle patch，通过插件管理器安装即可完成接线：patch 会在 Windows 上停用官方 ACL 档位，并插入本插件，使 seam 上始终只有一个 `ctx.sandbox` provider。

```yaml
# dsh-sandbox-windows-mxc/cordis.patch.yml（随包发布，节选）
- id: sandbox
  disabled: !!js process.platform === 'win32'

- insert:
    - id: sandbox-mxc
      name: dsh-sandbox-windows-mxc
      disabled: !!js process.platform !== 'win32'
```

其他平台上官方后端保持不变，本行保持停用。不要同时挂载两行：seam 只接受一个 `ctx.sandbox` provider，第二个注册会失败。

### 最小配置

除执行器可被解析外，无需任何配置。

```yaml
- id: sandbox-mxc
  name: dsh-sandbox-windows-mxc
  config:
    readOnlyRoots:
      - 'C:\Program Files\nodejs'
```

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `execPath` | 未设置 | 要调用的 MXC 执行器。省略时按当前架构从 `@microsoft/mxc-sdk` 的载荷解析（若缺失则回退到随包发布的另一架构），或使用 `DSH_MXC_EXEC`。配置了一个不存在的路径会在首条受限命令处故障关闭。 |
| `containment` | 'processcontainer' | MXC 的 containment 选择。'process' 让 MXC 自行解析宿主原生进程后端；'processcontainer' 固定使用 Windows ProcessContainer 后端。 |
| `readOnlyRoots` | [] | 受限命令可额外读取（绝不可写）的目录。MXC 的 AppContainer 档位没有环境自带读权限，因此工作区之外任何普通命令需要读取的内容——工具链、包缓存、凭据目录——都要写在这里。工作区本身始终可读。**工作区若在非系统盘上，必须把该盘根写进来**（`'D:\\'`）：Node 会 lstat 每一级父目录，盘根没授权会让沙箱内所有 Node 进程直接以 `EPERM` 退出。 |
| `deniedPaths` | [] | MXC 直接拒绝的路径。执行方式取决于后端；被拒绝会通过沙箱事实上报。 |
| `contractVersion` | '1.0.0' | 每份请求携带的精确 MXC 契约。把它设为执行器支持的版本（`@microsoft/mxc-sdk` 0.8.x 的载荷用 `0.9.0-alpha`）；MXC 会拒绝超出其支持范围的请求，本插件会在命令运行前先验证这一点。 |
| `network` | 'allow' | 'allow' 让网络与无隔离时完全一致，因为沙箱 seam 的模式只管文件效果。'deny' 选用 MXC 的出向/入向拒绝，这是比 seam 承诺更强的姿态。 |
| `ui` | 'allow' | 桌面是否保持可达。**`deny` 是 MXC 自己的默认值，而它会直接废掉 harness 在 Windows 上的 shell 工具**：Windows 程序需要 Win32k 才能完成初始化，PowerShell（以及 Node）因此会在执行任何东西之前以 `STATUS_DLL_INIT_FAILED`（0xC0000142）退出——本机实测确认。`allow` 表示桌面与无隔离时一致，与官方 Windows 档位相同；`deny` 选用 MXC 的 UI 拒绝，此后只有完全不碰 UI 子系统的程序能跑。 |
| `clipboard` | 'none' | 当 `ui: allow` 时受限命令的剪贴板权限：`none`、`read`、`write`、`all`。 |
| `allowInputInjection` | false | 当 `ui: allow` 时是否允许合成键盘/鼠标输入。 |
| `environment` | 'child' | 'child' 让受限命令拿到 harness 组装的完整环境（已由 subprocess 服务完成清洗）。'child+profile' 会再把这份环境叠加到调用用户的 Windows 配置文件环境之上，profile 作用域变量（以及 MXC 要求的平台变量）由此可达。 |
| `allowDaclMutation` | true | MXC 是否可以在兜底隔离步骤中写入宿主文件系统 DACL。设为 false 即拒绝该兜底，于是需要它的档位会失败，而不是改动宿主 ACL。 |
| `clearPolicyOnExit` | true | true 表示撤销 MXC 为这一条命令应用的 ACL。false 表示保留它们（MXC 的复用缓存），会在宿主上留下长期状态。 |
| `denialReport` | 未设置 | MXC 拒绝记录报告的输出路径。要求 `containment: processcontainer`。采集以 block 模式运行：既记录，也照旧拒绝。 |
| `retainEtl` | false | 在报告旁保留 MXC 封存的 ETL 轨迹。要求 `denialReport`；保留的轨迹可能包含敏感路径。 |
| `denialSignatures` | [] | 本部署额外认定的“被拒绝”stderr 子串（大小写不敏感）。通常不需要：方言已从宿主推导；仅在自研 runner 的措辞或本插件无法读取的语言环境下使用。 |
| `mxcArgs` | [] | 传给执行器的额外参数，位于请求文件之前；例如传入 --debug 可打开 MXC 的诊断输出。 |

未知字段会在插件挂载时被拒绝，拼写错误会直接报出自己，而不是悄悄取默认值。

-----

<a id="how-a-mode-becomes-an-mxc-request"></a>
## 模式如何变成 MXC 请求

seam 的两个受限模式都是文件效果策略，各自变成一份 MXC `1.0.0` 请求。插件不发送执行超时：命令的截止时间由 harness 的 shell 执行器负责，再加一个截止时间会把超时报成 MXC 的结果。

| 请求字段 | read-only | workspace-write |
|---|---|---|
| `filesystem.readwritePaths` | []，没有任何可写位置 | [workspaceRoot, 本次私有临时目录] |
| `filesystem.readonlyPaths` | [workspaceRoot, ...readOnlyRoots] | [...readOnlyRoots] |
| `filesystem.deniedPaths` | deniedPaths | deniedPaths |
| `process.env` | harness 的环境，扣除它自己的启动标记 | 同上，且 TMP/TEMP 指向私有临时目录 |
| `process.cwd` | 调用方的工作目录，始终显式给出 | 同上 |
| `network` | config.network（显式姿态；省略意味着 deny） | 同上 |
| `ui` | { disable, clipboard, injection }，显式写出——因为 MXC 自己的默认值是 `disable: true` | 同上 |
| `lifecycle` | { destroyOnExit: true, preservePolicy: !clearPolicyOnExit } | 同上 |
| `fallback` | { allowDaclMutation } | 同上 |
| `containerId` | dsh-&lt;sha256(工作区, 会话)[0..24]&gt; | 同上 |
| `version` | `config.contractVersion`（默认 `1.0.0`） | 同上 |

私有临时目录由 runner 在该次调用所属的临时根下创建，被授予读写，作为 TMP/TEMP 发布，并在结束后删除。若临时根就是工作区、或位于工作区之内，会在任何启动之前被拒绝：否则两份授权将无法区分。

排障时给 runner 调用加上 `--print-config`，即可在不运行任何东西的情况下看到被包装 argv 会生成的精确请求。

-----

<a id="failures-and-recovery"></a>
## 失败与恢复

三种结果始终区分开，因为其中只有一种是任务失败：

| 结果 | 表现方式 |
|---|---|
| 命令运行了，某个文件效果被拒绝 | 消费者侧的拒绝事实，与本后端的方言匹配：静态英文措辞，加上本插件从宿主读取的 `ERROR_ACCESS_DENIED` 措辞的两种读法 |
| 命令运行了，自己失败了 | 普通的非零退出码 |
| 沙箱根本没运行这条命令 | `SandboxUnavailableError`，错误码 `SANDBOX_UNAVAILABLE`，并带上 runner 的具体原因 |

runner 侧失败会在 stderr 打印 `mxc-sandbox-run: <detail>` 并以 `127` 退出。包装命令的输出从不被改写，因此消费者同时用退出码与该签名来分类。

MXC 侧的拒绝通过两条路径到达消费者，因为 MXC 有两种表达方式：

- **在任何东西运行之前**：provider 每个生命周期验证一次“执行器是否接受本次调用会发出的请求”——把请求交给 `wxc-exec.exe --dry-run`（只解析与校验，随后退出）。被拒绝时在 `confine()` 抛出 `SANDBOX_UNAVAILABLE`，并带上 MXC 自己的原文——这正是装了一个契约与 `contractVersion` 不一致的 SDK 后会遇到的场景。不支持 dry run 的执行器不会给出结论，因此该探测绝不会把可用的后端误判为不可用。
- **运行过程中**：MXC 以 JSON 错误信封写在 stderr 最后一行的拒绝，会被转换成同一套 `127` + 签名词汇，原始信封原样留在 stderr 供运维查看。

| 看到的信息 | 处理 |
|---|---|
| execPath does not exist / cannot resolve @microsoft/mxc-sdk | 安装 SDK、设置 `execPath`，或设置 `DSH_MXC_EXEC` |
| MXC refused the request (backend_unavailable) | 宿主低于 MXC 的 ProcessContainer 下限，或该档位不可用；查看 `wxc-exec.exe --probe` 的输出 |
| --temp is not an existing directory | harness 传入的临时根在此宿主机上不存在 |
| --workspace is not an existing directory | 会话的工作目录在命令运行前已被删除（或是失效的 junction） |
| MXC refuses an explicit environment without … | 设置 `environment: child+profile`，让 MXC 补上平台必需变量 |
| 受限命令读不到自己的工具链 | 把该目录加入 `readOnlyRoots` |
| 沙箱内任何 Node 进程报 `EPERM: operation not permitted, lstat 'D:\'` | 工作区在非系统盘上，而该盘根在容器内不可读，Node 的模块解析会 lstat 每一级父目录。给它授权（`readOnlyRoots: ['D:\\']`），或执行一次 `wxc-host-prep prepare-system-drive --target D:\`（需管理员；只加一条不可继承的读取属性 ACE）。 |
| the installed MXC executor refuses this request: Config schema version … is newer than supported | SDK 的契约与 `contractVersion` 不一致；把 `contractVersion` 钉到受支持的版本，或升级 `wxc-exec` |

-----

<a id="understand-the-implementation"></a>
## 实现说明

两半，一份契约：

- **`index.js`——provider**：解析策略、定位执行器、推导容器 ID，并返回包装后的 argv 与 enforcement、拒绝方言、runner 失败事实。它不持有宿主状态、不做任何应用，并且拒绝在非 Windows 上工作。
- **`runner.js`——runner**：provider 启动的独立 Node 入口。它重新校验自己的参数、推导 MXC 请求（`src/policy.js`）、把调用方 argv 重新拼成命令行（`src/quote.js`）、把请求写进私有临时文件、以调用方的 stdin/stdout 继承与 stderr 管道的方式启动执行器、镜像退出码，并删除自己的临时目录与请求文件。

两半之间唯一的接口是 argv 方言（`src/argv.js`），以旗标形式写出，因此被包装命令的 argv 本身就是它的诊断。runner 刻意不 import 任何 harness 包：即使 profile 的模块图很不寻常，它也必须能在 profile 的 Node 下启动。

runner 会拒绝 harness 的 subprocess 控制通道标记，而不是悄悄丢弃它。该通道是 fd 7 上的继承描述符，而 MXC 的执行器契约是 JSON 请求文件加 MXC 自有的 stdio，无法把这个描述符传过去。因此受隔离的 PTC 调用会带着明确原因故障关闭，而不是静默丢失通道；所有经由 `ctx.shell` 的进程启动都不受影响。

-----

<a id="verification"></a>
## 验证

```bash
npm install
npm test
```

`node tests/run.js` 把所有测试套件 import 进同一个进程，因此在宿主拒绝 fork 子进程的环境里也能跑；`node tests/run.js runner` 只跑其中一个文件。

| 套件 | 固定的事实 |
|---|---|
| tests/quote.test.js | 用独立编写的解析器验证 Windows 命令行引号规则：引号、行尾反斜杠、空参数、制表符、换行、Unicode |
| tests/config.test.js | 每个默认值，以及非法配置会点名自己的字段与可接受取值 |
| tests/policy.test.js | 模式到请求的映射、逐次调用的 lifecycle、容器 ID 推导、子进程环境 |
| tests/argv.test.js | 完整 argv 的构造与解析互相一致，非法 argv 故障关闭 |
| tests/classify.test.js | enforcement 上报、拒绝方言、runner 失败规则、MXC 信封识别 |
| tests/paths.test.js | 规范化的包含关系判断，含真实的 NTFS junction |
| tests/locate.test.js | 执行器解析顺序（execPath、DSH_MXC_EXEC、SDK 载荷、架构回退）与 runner 入口回退 |
| tests/provider.test.js | 把 provider 挂在真实的 @deepseek-ai/dsh-sandbox seam 上：包装 argv、按配置生成 argv、按会话区分的容器 ID、每条故障关闭路径 |
| tests/runner.test.js | 用 stub 执行器端到端验证 runner：请求内容、环境、私有临时目录生命周期、输出转发、退出码镜像、信封分类、临时根防护、控制标记拒绝、`--print-config` |
| tests/manifest.test.js | bundle patch、exports 与 files 列表、两个语言的展示元数据、图标 |
| tests/live/harness.mjs | 启动真实 dsh profile：`ctx.sandbox` 是本 provider、`ctx.shell` 通过它受限执行命令、工作区写入被允许、工作区外写入被拒绝且被 harness 判为拒绝 |

### 真机验收

```bash
npm run acceptance              # 对真实执行器的 provider 验收；用 DSH_MXC_EXEC 指定执行器
npm run acceptance:harness      # 启动一个真实 dsh profile，走它自己的 shell 工具
```

`tests/live/acceptance.mjs` 把 provider 挂在真实 seam 上，受限一个 argv，然后原样启动 `confine()` 返回的内容，并断言五项事实。**在 Windows 11 25H2（build 26200.9457）上、使用 `@microsoft/mxc-sdk` 0.8.0 载荷并钉到其 `0.9.0-alpha` 契约，实测结果：**

| 用例 | 观察结果 |
|---|---|
| read-only 执行 `cmd /c echo …` | 正常运行，退出码 0，输出逐字节转发；上报 `enforcement: 'partial'` |
| 带管道的 Node 孙进程，以及它自己创建并连接的命名管道 | 四种模式全部成功（`inherit`、`node-pipe`、`cmd-pipe`、`named-pipe`）——官方 ACL 后端记录为"不可能"的那类 EPERM 在此档位未复现 |
| workspace-write，写工作区内 | 允许，退出码 0，文件内容符合预期 |
| workspace-write，写工作区之外 | 被拒绝，退出码 1，**没有创建文件** |
| 同样的写入，无隔离执行（对照） | 成功——因此上面的拒绝来自沙箱策略，而不是宿主的权限 |
| 消费者看到的“被拒绝” | 由方言中从宿主推导的读法匹配成功（harness 会把子进程 OEM 编码的 stderr 按 UTF-8 解码，这正是那种字节级读法存在的原因） |
| 对该执行器使用 `contractVersion: 1.0.0` | 在任何东西运行之前抛出 `SANDBOX_UNAVAILABLE`，携带 MXC 原文 “Config schema version '1.0.0' is newer than supported (supported: >=0.6, <=0.9)” |

该宿主上 `wxc-exec.exe --probe` 报告 `tier: "base-container"`、`baseContainerApiPresent: true`、`needsDaclAugmentation: false`、`isolationSessionAvailable: false`——即 MXC 最新的档位，不需要改动宿主 DACL。

### 装进真实 dsh，并走 harness 自己的 shell 工具

```bash
npm run acceptance:harness          # 用 DSH_HARNESS_PROFILE 选择 profile（默认 web）
```

`tests/live/harness.mjs` 按 CLI 的方式加载真实 profile（先各 bundle 层，再 profile 自己的 patch 文件）、启动整棵树，并对**运行中的服务**断言，而不是对本插件自己的输出断言。**实测环境：`D:\task\deepseek-harness` 的 dsh 0.1.5-rc.2、web profile，插件以实时链接方式安装：**

| 用例 | 观察结果 |
|---|---|
| `ctx.sandbox` | **`MxcSandboxProvider`**——本插件就是被挂载的 provider，官方 ACL 档位已被 bundle patch 停用 |
| `ctx.shell`（真实的 `dsh-pwsh-sandbox`） | 受限执行前台命令，退出码 0，输出转发：`echo harness-mxc-ok` |
| 结果中的沙箱事实 | `{ mode: 'workspace-write', denied: false, enforcement: 'partial' }` |
| 一个 Node 进程（`node -e "console.log(1+1)"`） | 在沙箱内运行，退出码 0——模块解析通过，这需要工作区所在盘被授权 |
| 在工作区内 `Set-Content` | 允许，文件内容符合预期 |
| 在工作区外 `Set-Content` | 被拒绝（退出码 1，未创建文件），stderr 为 `Access to the path '…' is denied.` |
| harness 自己的分类 | `denied: true`，且**没有**被报成 runner failure |
| 同样的写入，无隔离执行（对照） | 成功——拒绝来自策略，而不是宿主权限 |

**唯一改变了默认值的事实：** 在 MXC 自己的 `ui.disable: true` 下，PowerShell——也就是 harness 在 Windows 上的 shell 工具——会在执行任何东西之前以 `STATUS_DLL_INIT_FAILED`（0xC0000142）退出，因为它需要 Win32k 完成初始化；Node 同样如此。正反两面都验证过：同一条 `pwsh` 命令在 MXC 下，无 UI 权限时退出 `-1073741502`，有 UI 权限时退出 `0`。因此本插件的默认值是 `ui: allow`（桌面与无隔离时一致，和官方 Windows 档位相同），而不是 MXC 的 `deny`。想要更严姿态的运维可以设 `ui: deny`，代价是此后只有不碰 UI 的程序能跑。

### 尚未验证的部分

- **`1.0.0` 契约尚未端到端跑过**：验收机上没有随包发布 `1.0.0` 执行器的 SDK 版本，因此对其发布 schema 的逐字段匹配仍以 schema 与文档为依据。以上全部实测跑在 `0.9.0-alpha` 下。
- **升级与审批路径仍未测试**：harness 工具层已经驱动过（`npm run acceptance:harness`），但只用了当时已有的许可。需要审批提示的命令、升级重试到 `danger-full-access`、以及 Web UI 中的拒绝渲染都还没有跑过。
- **Electron 的 desktop profile 未测试**：dsh CLI 拒绝管理它（“profile desktop is managed exclusively by the Electron application”），所以本插件只装进了 CLI 管理的 profile。
- **其他后端与诊断**：`wslc`、`windows_sandbox`、`isolation_session`（本机存在该服务，但 probe 报告其不可用）、`--audit` 模式、拒绝记录产物，都不在本插件已测路径内。
- **本地化拒绝措辞只验证了一种语言**（zh-CN，本机即为此）。其他语言依赖同一套推导，按构造与语言无关，但只观察过 zh-CN。

runner 套件会启动子进程；在禁止 fork 的宿主（或沙箱）里，它们会以 spawn 错误失败，而不是插件缺陷。真机验收需要真实执行器，且不属于 `npm test`。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **enforcement 始终上报 partial。** NTFS 硬链接会让同一个文件对象在多个路径上出现，因此被授权的工作区文件仍有一个授权根之外的地址；DACL 上写有其他沙箱 AppContainer 包 SID 的目录树无法被受限子进程打开；所选档位取决于宿主（较新版本上 MXC 的 base-container 档位保留了调用方环境中的读权限，而不是限制它）；以 allow 模式采集拒绝则意味着记录的同时放行。需要绝对边界的消费者必须拒绝此后端，而不是把它当作 full。
- **读权限是显式授予的，因为某些档位确实需要。** MXC 的 AppContainer 档位起始时没有任何环境自带读权限，因此工作区以及每个 `readOnlyRoots` 条目都会被授予读取；而在 base-container 档位下读权限本来就是环境自带的，该授权是冗余但无害的。也正因如此，`readOnlyRoots` 应该写目录而不是整个盘符。
- **管道 stdio 与命名管道在 base-container 档位下可用——但这是档位事实，不是保证。** 官方 ACL 后端记录的是相反结论：libuv 的管道 stdio 用命名管道，客户端打开时申请的写权限没有任何受限 SID 被授予，于是受限进程内 `spawn(…, { stdio: 'pipe' })` 会以 `EPERM` 失败。在 MXC 下（本机 `tier: base-container`，该档位保留调用方身份做对象访问检查，而不是替换身份）这个失败没有复现：继承 stdio 的 spawn、带管道的 Node 孙进程、带管道的 `cmd`、以及受限进程自己创建并连接的命名管道全部成功——由 `npm run acceptance` 固定。而在 AppContainer/DACL 档位下身份确实被替换，同类拒绝很可能重新出现；该路径本机未验证。
- **工作区需要宿主侧 ACL 应用**（AppContainer 档位下），MXC 会逐条命令应用并在之后撤销（`clearPolicyOnExit: true`）；`allowDaclMutation: false` 会拒绝这条兜底路径，代价是需要它的档位不可用。
- **默认保持桌面可达。** 默认 `ui: allow`，因为 Windows 程序（包括 PowerShell 与 Node）没有 Win32k 就无法初始化；剪贴板仍为 `none`，输入注入仍被拒绝。`ui: deny` 给出 MXC 更严的姿态，代价是所有触碰 UI 子系统的程序都跑不起来。
- **没有交互式终端。** MXC 的 one-shot 执行器拥有进程的 stdio；本插件转发调用方的 stdio，但不实现 PTY。harness 基于 PTY 的终端工具不经过 `ctx.sandbox`，不受影响。
- **MXC 请求会带上子进程的完整环境**——TMP/TEMP 就是这样指向被授权的私有目录的——因此其中包含 profile 提供的全部凭据。runner 会把它写入系统临时根，仅存活于一条命令的时间，随后删除；`--print-config` 会打印同样的内容（并在 stderr 给出提示）。两者都应按敏感数据处理；与其他本地用户共享的临时根，等同于与他们共享这些内容。
- **subprocess 控制通道被拒绝**，而不是转发（见上文）。如果某个 profile 依赖受隔离的 PTC 执行，请继续使用 `@deepseek-ai/dsh-sandbox-local`。
- **一次只说一份精确契约。** MXC 对每份请求做版本校验，超出执行器支持范围的会被拒绝；本插件只发送 `contractVersion` 指定的那一份。命令前的 `--dry-run` 校验会把这种拒绝转成 `SANDBOX_UNAVAILABLE`（在运行之前），因此版本不一致表现为故障关闭的沙箱，而不是静默的隔离不足——但这也意味着，遇到本插件尚未支持的契约需要设置 `contractVersion`（或更新插件），而不是期待回退。
- **待办：** `1.1.0-alpha` 契约（逐命令 leastPrivilege、enumeratePaths）、把 MXC 的 probe 输出通过工具或 inspect provider 暴露出来、`wslc`/`isolation_session` 边界（它们属于整能力替换，而不是沙箱档位），以及经由 harness 自身 bash/pwsh 工具层的 profile 级验收。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

- **为什么不直接复用官方 ACL 档位？** harness 已经自带 `@deepseek-ai/dsh-sandbox-windows-acl`；本插件存在是因为 MXC 是另一种取舍——由微软维护、策略驱动，代价是原生载荷、24H2+ 的系统下限，以及必须显式授予的读权限。两者是同一个 seam 的替代方案，从不互补。
- **真相所在：** `src/policy.js` 是模式变成请求的唯一位置，`src/denial.js` 是拒绝方言的唯一推导位置，`src/contract.js` 是判断执行器是否接受的唯一位置；分别由 `tests/policy.test.js`、`tests/denial.test.js`、`tests/contract.test.js` 钉住。runner 除了重新校验拿到的内容之外，不添加任何自己的策略。
- **新增一个配置字段**意味着四处修改：`src/config.js` 的键列表与校验、`src/policy.js` 的映射、`src/argv.js` 的旗标（构造与解析两侧），以及上面的表格。`tests/argv.test.js` 证明两侧一致。
- **为什么需要 runner？** seam 交过来的是 argv，MXC 要的是 JSON 请求——这个形状变化无法"以 argv 的形式"表达，所以必须有进程做翻译；而 MXC 的 `wxc-exec <config> -- <command>` 覆盖写法并不能免掉它，只是把命令从文件里挪了出来：仍然需要有东西写出「每次调用都不一样」的请求（mode、工作区、临时根、会话 id）并在之后删除。runner 负责的就是这件事，外加三样换成别的做法就会丢掉的东西：`stderr` 走管道，才能把 MXC 的错误信封转成 seam 的 `127` + 签名（否则"沙箱拒绝"和"命令失败"看起来一模一样）；私有临时目录逐次创建与删除（provider 因此保持无状态）；命令行的引号由这里完成（`src/quote.js`）而不是让 MXC 从 argv 拼，这样引号规则就是文档化的 `CommandLineToArgvW` 那套，并且被测过。`node tests/live/chain.mjs` 会打印一条命令完整的四层链路。
- **不要把 harness 包 import 进 runner。** 它运行在 profile 的 Node 与 profile 的环境下；它的 import 只有 Node 内置模块和自己的 `src/` 模块。

</details>
