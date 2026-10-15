<!--
标题（发帖时用这个）：
DSH | dsh-sandbox-windows-mxc | 用微软 MXC 给 Windows 提供进程沙箱后端
-->

**_> 非官方项目，由社区成员独立开发和维护。_**

**项目地址：**
https://github.com/whale4rain/dsh-sandbox-windows-mxc

**项目介绍：**

把 DSH 在 Windows 上的进程沙箱档位，从「harness 自己改宿主 DACL」换成**微软的 eXecution Container（MXC）**：命令交给 `wxc-exec.exe`，由 MXC 的 `ProcessContainer` 后端在容器里启动，文件策略由 MXC 执行，退出码原样回传。

（有点接上一条关于 MXC 的讨论 #9715——当时的问题「MXC 是换一个后端，还是更大的改动」，答案是前者：它是一个同一个 seam 上的替代后端。）

本插件只占一个位置：`ctx.sandbox`。bash/pwsh 执行器（`dsh-bash-sandbox` / `dsh-pwsh-sandbox`）、文件写入闸门、升级提示等全部**不需要任何改动**——它们本来就是对着 `ConfinedArgv` 的四个字段（`argv` / `enforcement` / `denialSignatures` / `runnerFailureRules`）编程的。

### 和 DSH 的集成方式

装的是一个 bundle，patch 做两件事：Windows 上停用官方的 `sandbox` 行（`@deepseek-ai/dsh-sandbox-local`），插入 `sandbox-mxc`。

```yaml
# dsh-sandbox-windows-mxc/cordis.patch.yml（节选）
- id: sandbox
  disabled: !!js process.platform === 'win32'

- insert:
    - id: sandbox-mxc
      name: dsh-sandbox-windows-mxc
      disabled: !!js process.platform !== 'win32'
```

安装（CLI 会自动把 bundle 加进 `dsh.profile.bundles`）：

```bash
# 1. 装 MXC 载荷（原生二进制，Windows 更新不提供）
npm install @microsoft/mxc-sdk

# 2. 把插件装进某个 profile
dsh plugin --profile web add link:<克隆下来的目录>

# 3. 看一眼执行器支持哪份契约，再启动
wxc-exec.exe --probe
```

seam 的两个受限模式各自变成一份 MXC 请求（默认说 `1.0.0` 契约，可用 `contractVersion` 钉到你机器上执行器支持的那一份）：

| 请求字段 | `read-only` | `workspace-write` |
|---|---|---|
| `filesystem.readwritePaths` | `[]` | `[工作区, 本次私有临时目录]` |
| `filesystem.readonlyPaths` | `[工作区, ...readOnlyRoots]` | `[...readOnlyRoots]` |
| `process.env` | harness 的环境（扣除它自己的启动标记） | 同上，且 `TMP/TEMP` 指向私有临时目录 |
| `network` / `ui` / `lifecycle` / `fallback` | 显式写出（MXC 这几项的缺省值都偏严） | 同上 |

常改的几个配置项：

| 配置 | 默认 | 作用 |
|---|---|---|
| `execPath` | 自动解析 | 指定 `wxc-exec.exe`（否则按 `DSH_MXC_EXEC` → SDK 载荷 → 架构回退的顺序找） |
| `contractVersion` | `'1.0.0'` | 钉住 MXC 契约；旧 SDK 用 `'0.9.0-alpha'` |
| `readOnlyRoots` | `[]` | 工作区之外额外允许**读**的目录（AppContainer 档位必需） |
| `ui` | `'allow'` | 桌面是否可达；`'deny'` 更严，但 PowerShell/Node 起不来 |
| `network` | `'allow'` | `'deny'` 可选用 MXC 的出/入向拒绝（seam 本身只管文件效果） |
| `denialReport` | 未设置 | 让 MXC 产出结构化拒绝报告（仍照旧拒绝） |

### 验证做到了哪一步

全部在同一台机器上实测：Windows 11 25H2（build 26200.9457）、`@microsoft/mxc-sdk` 0.8.0 载荷、DSH 0.1.5-rc.2、web profile。

**① 单元测试 91 项全过**（`npm test`）：命令行引号规则对着独立写的解析器做往返、模式→请求映射、argv 构造/解析一致、拒绝方言、契约探测、真实 seam 上的 provider、以及用桩执行器端到端跑 runner。

**② 真机 provider 验收 7 项全过**（`npm run acceptance`，直接对 `wxc-exec.exe`）：

```
ok   read-only command runs confined and relayed — exit=0 stdout="mxc-acceptance"
ok   enforcement is reported as partial — partial
ok   a write inside the workspace is allowed — exit=0 content="inside"
ok   a write outside the workspace is denied — exit=1 file=false
ok   the same write succeeds unconfined (control) — exit=0
ok   the denied write is recognisable as a denial
ok   an unsupported contract is refused before running — SANDBOX_UNAVAILABLE
```

**③ 装进真实 DSH、走 harness 自己的 shell 工具 13 项全过**（`npm run acceptance:harness`，按 CLI 的方式加载 profile 并启动整棵树，然后对运行中的服务断言）：

```
ok   ctx.sandbox is this plugin provider — MxcSandboxProvider
ok   the harness shell executor is mounted
ok   a command runs confined through the harness — exit=0 stdout="harness-mxc-ok"
ok   a workspace write is permitted — exit=0 content="inside"
ok   an outside write is denied — exit=1 file=false
ok   the harness classifies it as a denial — {"mode":"workspace-write","denied":true,...}
ok   the harness does not call it a runner failure
ok   the same write succeeds unconfined (control) — exit=0
```

也就是说：**`ctx.sandbox` 已经是本插件（官方 ACL 行可见地处于停用状态），真实的 pwsh 执行器受限执行命令，工作区外的写入被 MXC 拒绝，而且 harness 自己把它判为 `denied: true` 而不是任务失败**——同时对照组证明这个拒绝来自策略而不是宿主权限。

### 过程中踩到的三个坑（可能对其他人有用）

**1. MXC 的 UI 策略默认会直接废掉 PowerShell。** MXC 自己的 `ui.disable` 缺省是 `true`，而 Windows 程序需要 Win32k 才能完成初始化：PowerShell——也就是 harness 在 Windows 上的 shell 工具——和 Node 都会在执行任何东西之前以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）退出。同一条 `pwsh` 命令在 MXC 下实测：不给 UI 权限退出 `-1073741502`，给权限退出 `0`。所以本插件把 `ui` 的默认值定为 `allow`（桌面与不隔离时一致，和官方 Windows 档位相同），剪贴板仍是 `none`、输入注入仍拒绝；想要更严就设 `ui: deny`，代价是所有碰 UI 的程序都跑不起来。

**2. MXC 对契约版本是强校验的，而且「旧版」比想象中常见。** 0.8.0 的执行器只支持 `>=0.6, <=0.9`，会直接拒绝 `1.0.0` 请求；偏偏 MXC 的拒绝是 stderr 上的一段纯文本、不占退出码，很容易被消费者当成「命令失败了」。所以插件的做法是两层：`contractVersion` 可配置（把请求钉到执行器支持的那一份契约），并且在**任何东西运行之前**用 `wxc-exec --dry-run` 校验一次，把拒绝转成 `SANDBOX_UNAVAILABLE`（附带 MXC 原文）；执行器不支持 dry run 时「不给结论」，绝不误杀可用后端。

**3. 拒绝信息会被本地化，英文签名在中文宿主上一个都匹配不上。** 被 MXC 拒绝时，`cmd` 写出的是 OEM 代码页的中文「拒绝访问。」，而 harness 按 UTF-8 解码子进程 stderr——两边永远对不上。现在插件会向宿主自己的消息表查询 `ERROR_ACCESS_DENIED`（用 ASCII 码点传输，避免控制台编码损坏），并把消息本身和「按 UTF-8 误读后的字节序列」**两种读法**都注册为签名，另外留了 `denialSignatures` 逃生口。

### 已知限制（先说清楚）

- **`enforcement` 恒为 `partial`**：NTFS 硬链接会让同一文件对象出现在授权根之外；DACL 上写有其他沙箱 AppContainer 包 SID 的目录树，受限子进程打不开；所选的档位取决于宿主（本机 probe 是 `base-container`，读权限是环境自带的，而 AppContainer 档位没有）。需要绝对边界的消费者应当拒绝此后端。
- **读权限必须显式授予**（`readOnlyRoots`）：MXC 的 AppContainer 档位没有环境自带读权限，工作区之外要读的工具链、包缓存、凭据目录都得列出来。
- **受隔离的 PTC 执行不可用**：它依赖 fd 7 上的继承控制通道，而 MXC 的执行器契约是 JSON 请求文件，描述符传不过去——插件会明确拒绝而不是静默丢弃。依赖沙箱化 PTC 的 profile 请继续用官方后端。
- **没有交互式终端**（MXC 的 one-shot 执行器拥有 stdio），PTY 类工具不走 `ctx.sandbox`，不受影响。
- **需要 Windows 11 24H2+ 和自备的 MXC 载荷**（解包约 105 MB，Windows 更新不提供）。
- **尚未验证**：审批/升级路径（需要审批提示的命令、升级到 `danger-full-access`、Web UI 里的拒绝渲染）、Electron 的 desktop profile（CLI 明确拒绝管理它）、`1.0.0` 契约的端到端（本机执行器是 0.8.0）、`wslc` / `isolation_session` 等其他 MXC 后端。

### 和官方 ACL 档位怎么选

官方 `sandbox-windows-acl` 是「受限令牌 + 能力 SID」，不需要额外依赖，但需要改写宿主 DACL，并且有一份长期存在的文档化缺口（硬链接、读不设限、Low 完整性标签）。MXC 是「策略驱动 + 微软维护」，代价是原生载荷、系统下限、以及必须显式写出的读权限。两者是**同一个 seam 的替代方案，不是互补**——所以 patch 里是把官方行停用后接管，而不是再加一个档位。

MIT 许可。欢迎使用和拍砖，尤其是：AppContainer 档位（而不是 base-container）的机器上表现如何、以及非中文宿主上拒绝方言是否仍然匹配得上。

---

## 截图清单（发帖前删除本节）

截图需要你发帖时拖进来，下面三张是我们已经确认能渲染的界面：

1. **接管证据**：`设置 → 插件 → 插件列表 → 全局插件`，搜索框输入 `sandbox`。同一屏里应当同时看到 `sandbox-windows-mxc  已启用   sandbox-mxc` 和 `sandbox-local  已停用   sandbox`（我已确认这两个行会同时出现）。
2. **真机验收输出**：终端里 `npm run acceptance` 与 `npm run acceptance:harness` 的输出（上面代码块就是原样输出，截图更直观）。
3. **会话里的拒绝呈现**：在 web profile 的会话里让 agent 执行一条越界写入（例如 `Set-Content -Path D:\task\x.txt -Value hi`），截 tool 结果里 `denied` 的呈现。这一张我们还没跑过，是最有说服力的一张。

另：图标与多语言标题/描述（`locale/en.json`、`locale/zh.json`、`icon.svg`）已经导出并通过 manifest 测试，但 0.1.5 的插件列表页显示的是行 id，所以它们目前没有可见的落点——发帖前不用特意截。
