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
| `readOnlyRoots` | [] | 受限命令可额外读取（绝不可写）的目录。MXC 的 AppContainer 档位没有环境自带读权限，因此工作区之外任何普通命令需要读取的内容——工具链、包缓存、凭据目录——都要写在这里。工作区本身始终可读。 |
| `deniedPaths` | [] | MXC 直接拒绝的路径。执行方式取决于后端；被拒绝会通过沙箱事实上报。 |
| `network` | 'allow' | 'allow' 让网络与无隔离时完全一致，因为沙箱 seam 的模式只管文件效果。'deny' 选用 MXC 的出向/入向拒绝，这是比 seam 承诺更强的姿态。 |
| `environment` | 'child' | 'child' 让受限命令拿到 harness 组装的完整环境（已由 subprocess 服务完成清洗）。'child+profile' 会再把这份环境叠加到调用用户的 Windows 配置文件环境之上，profile 作用域变量（以及 MXC 要求的平台变量）由此可达。 |
| `allowDaclMutation` | true | MXC 是否可以在兜底隔离步骤中写入宿主文件系统 DACL。设为 false 即拒绝该兜底，于是需要它的档位会失败，而不是改动宿主 ACL。 |
| `clearPolicyOnExit` | true | true 表示撤销 MXC 为这一条命令应用的 ACL。false 表示保留它们（MXC 的复用缓存），会在宿主上留下长期状态。 |
| `denialReport` | 未设置 | MXC 拒绝记录报告的输出路径。要求 `containment: processcontainer`。采集以 block 模式运行：既记录，也照旧拒绝。 |
| `retainEtl` | false | 在报告旁保留 MXC 封存的 ETL 轨迹。要求 `denialReport`；保留的轨迹可能包含敏感路径。 |
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
| `lifecycle` | { destroyOnExit: true, preservePolicy: !clearPolicyOnExit } | 同上 |
| `fallback` | { allowDaclMutation } | 同上 |
| `containerId` | dsh-&lt;sha256(工作区, 会话)[0..24]&gt; | 同上 |

私有临时目录由 runner 在该次调用所属的临时根下创建，被授予读写，作为 TMP/TEMP 发布，并在结束后删除。若临时根就是工作区、或位于工作区之内，会在任何启动之前被拒绝：否则两份授权将无法区分。

排障时给 runner 调用加上 `--print-config`，即可在不运行任何东西的情况下看到被包装 argv 会生成的精确请求。

-----

<a id="failures-and-recovery"></a>
## 失败与恢复

三种结果始终区分开，因为其中只有一种是任务失败：

| 结果 | 表现方式 |
|---|---|
| 命令运行了，某个文件效果被拒绝 | 消费者侧的拒绝事实，来自本后端的拒绝方言（“Access is denied.”、“Access to the path … is denied.”、EACCES/EPERM 的措辞） |
| 命令运行了，自己失败了 | 普通的非零退出码 |
| 沙箱根本没运行这条命令 | `SandboxUnavailableError`，错误码 `SANDBOX_UNAVAILABLE`，并带上 runner 的具体原因 |

runner 侧失败会在 stderr 打印 `mxc-sandbox-run: <detail>` 并以 `127` 退出。包装命令的输出从不被改写，因此消费者同时用退出码与该签名来分类。所有 MXC 侧拒绝（不支持的 containment、无可用后端、策略被拒）都以 JSON 错误信封出现在 stderr 的最后一行，会被转换成同一套 runner 失败词汇，同时原封不动地留在 stderr 供运维查看。

| 看到的信息 | 处理 |
|---|---|
| execPath does not exist / cannot resolve @microsoft/mxc-sdk | 安装 SDK、设置 `execPath`，或设置 `DSH_MXC_EXEC` |
| MXC refused the request (backend_unavailable) | 宿主低于 MXC 的 ProcessContainer 下限，或该档位不可用；查看 `wxc-exec.exe --probe` 的输出 |
| --temp is not an existing directory | harness 传入的临时根在此宿主机上不存在 |
| --workspace is not an existing directory | 会话的工作目录在命令运行前已被删除（或是失效的 junction） |
| MXC refuses an explicit environment without … | 设置 `environment: child+profile`，让 MXC 补上平台必需变量 |
| 受限命令读不到自己的工具链 | 把该目录加入 `readOnlyRoots` |

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

### 尚未验证的部分

开发本插件的机器上没有 MXC 载荷，因此**启动路径尚未对真实的 `wxc-exec.exe` 跑过**，也没有观察到任何实时的隔离断言。已验证的是本插件自身的契约：请求文档逐字段匹配 MXC 发布的 `1.0.0` schema；引号规则能通过独立编写的命令行解析器；失败词汇与文档化的执行器行为（退出码镜像、stderr 错误信封）一致。依赖它之前，请在 Windows 11 24H2+ 宿主机上做两项现场检查：

```powershell
# 1. 这台宿主实际会给出哪个 containment 档位？
& "<sdk>\bin\x64\wxc-exec.exe" --probe

# 2. 查看一条真实命令会运行在怎样的请求下。
node runner.js --workspace $PWD --mode read-only --exec "<sdk>\bin\x64\wxc-exec.exe" --print-config -- cmd /c "echo hello"
```

然后去掉 `--print-config`，确认 harness 渲染的两项事实：工作区之外的写入报为拒绝（而不是任务失败），不可用的执行器报为 `SANDBOX_UNAVAILABLE`。

runner 套件会启动子进程；在禁止 fork 的宿主（或沙箱）里，它们会以 spawn 错误失败，而不是插件缺陷。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **enforcement 始终上报 partial。** NTFS 硬链接会让同一个文件对象在多个路径上出现，因此被授权的工作区文件仍有一个授权根之外的地址；DACL 上写有其他沙箱 AppContainer 包 SID 的目录树无法被受限子进程打开；所选档位取决于宿主（较新版本上 MXC 的 base-container 档位保留了调用方环境中的读权限，而不是限制它）；以 allow 模式采集拒绝则意味着记录的同时放行。需要绝对边界的消费者必须拒绝此后端，而不是把它当作 full。
- **读权限是显式授予的。** MXC 的 AppContainer 档位起始时没有任何环境自带读权限，因此工作区以及每个 `readOnlyRoots` 条目都会被授予读取。这比读不设限的后端面积更大，也正是 `readOnlyRoots` 应该写目录而不是整个盘符的原因。
- **工作区需要宿主侧 ACL 应用**（AppContainer 档位下），MXC 会逐条命令应用并在之后撤销（`clearPolicyOnExit: true`）；`allowDaclMutation: false` 会拒绝这条兜底路径，代价是需要它的档位不可用。
- **没有交互式终端。** MXC 的 one-shot 执行器拥有进程的 stdio；本插件转发调用方的 stdio，但不实现 PTY。harness 基于 PTY 的终端工具不经过 `ctx.sandbox`，不受影响。
- **MXC 请求会带上子进程的完整环境**——TMP/TEMP 就是这样指向被授权的私有目录的——因此其中包含 profile 提供的全部凭据。runner 会把它写入系统临时根，仅存活于一条命令的时间，随后删除；`--print-config` 会打印同样的内容（并在 stderr 给出提示）。两者都应按敏感数据处理；与其他本地用户共享的临时根，等同于与他们共享这些内容。
- **subprocess 控制通道被拒绝**，而不是转发（见上文）。如果某个 profile 依赖受隔离的 PTC 执行，请继续使用 `@deepseek-ai/dsh-sandbox-local`。
- **不在运行期检测版本偏差。** 本插件说的是精确的 `1.0.0` 契约。MXC 会拒绝未知或不支持的请求，而不是部分应用；runner 会把这种拒绝转成 `SANDBOX_UNAVAILABLE`，因此未来契约的变化会表现为故障关闭的沙箱，而不是静默的隔离不足。
- **待办：** `1.1.0-alpha` 契约（逐命令 leastPrivilege、enumeratePaths）、把 MXC 的 probe 输出通过工具或 inspect provider 暴露出来、以及一套真机验收套件。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

- **为什么不直接复用官方 ACL 档位？** harness 已经自带 `@deepseek-ai/dsh-sandbox-windows-acl`；本插件存在是因为 MXC 是另一种取舍——由微软维护、策略驱动，代价是原生载荷、24H2+ 的系统下限，以及必须显式授予的读权限。两者是同一个 seam 的替代方案，从不互补。
- **真相所在：** `src/policy.js` 是模式变成请求的唯一位置，`tests/policy.test.js` 是它被钉住的地方。runner 除了重新校验拿到的内容之外，不添加任何自己的策略。
- **新增一个配置字段**意味着四处修改：`src/config.js` 的键列表与校验、`src/policy.js` 的映射、`src/argv.js` 的旗标（构造与解析两侧），以及上面的表格。`tests/argv.test.js` 证明两侧一致。
- **不要把 harness 包 import 进 runner。** 它运行在 profile 的 Node 与 profile 的环境下；它的 import 只有 Node 内置模块和自己的 `src/` 模块。

</details>
