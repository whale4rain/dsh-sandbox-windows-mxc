顺着这条讨论补一个落地结果：我按你说的「第 2 层」（一个包顶替 `ctx.sandbox`）做了，并在真机上跑通了。仓库：https://github.com/whale4rain/dsh-sandbox-windows-mxc

**验证方式**（不是纸面推演）：装进 dsh 0.1.5-rc.2 的 web profile，按 CLI 的方式加载 profile 并启动整棵树，然后对**运行中的服务**断言：`ctx.sandbox` 是本插件、真实的 `dsh-pwsh-sandbox` 受限执行命令退出 0、工作区内写入成功、工作区外写入被拒且被 harness 判为 `denied: true` 而不是 runner failure。另有 8 项直接对 `wxc-exec.exe` 的验收、91 项单测。

**几个和现有 ACL 档位假设不一样的点**（本机：Win11 25H2 / 26200、`@microsoft/mxc-sdk` 0.8.0、`tier: base-container`）：

- **`ui.disable` 默认 `true` 会直接废掉 PowerShell。** PowerShell 和 Node 都会在执行前以 `STATUS_DLL_INIT_FAILED`(0xC0000142) 退出；同一条命令给 UI 权限退出 0、不给退出 `-1073741502`。所以 `ui` 必须显式写，我把默认设成 `allow`（剪贴板仍 `none`、输入注入仍拒绝）。
- **契约是强校验的，而拒绝不算"沙箱失败"。** 0.8.0 只支持 `>=0.6, <=0.9`，`1.0.0` 请求直接被拒；拒绝只是 stderr 上一段纯文本、不占退出码，不做处理就会被当成普通任务失败。现在 provider 用 `wxc-exec --dry-run` 先验一次，拒绝转成 `SANDBOX_UNAVAILABLE`（执行器不支持 dry run 时"不给结论"，不会误杀可用后端）。
- **你提到的那类管道 stdio EPERM 在本机档位没有复现。** 继承 stdio、带管道的 Node 孙进程、带管道 `cmd`、受限进程自建命名管道，四种全过。原因大概是 base-container 档位保留调用方身份做对象访问检查，而不是换身份。但这是**档位事实不是保证**：T3（AppContainer + DACL）没机器可测，那里身份确实被替换，很可能回到 EPERM。
- **另一处 EPERM 确实存在。** 工作区在非系统盘时，Node 的模块解析会 lstat 各级父目录，未授权的盘根会让沙箱内**所有** Node 进程以 `EPERM: ... lstat 'D:\'` 推出。修法：`readOnlyRoots: ['D:\']`（免管理员），或管理员跑一次 `wxc-host-prep prepare-system-drive --target D:\`。
- **拒绝信息会被本地化。** 中文宿主打印「拒绝访问。」且是 OEM 编码字节，而 harness 按 UTF-8 解码子进程 stderr，英文签名一个都不命中——策略拒绝会被报成任务失败。现在按主机消息表推导方言，把消息本身和"误读后的字节序列"两种读法都注册。

关于你最后提到的 `SandboxUnavailableError` 文案：同意下游改不了，只能在 `detail` 里补具体原因。要让 MXC 主机上的报错不再建议"装 bubblewrap"，确实需要 provider 能贡献补救文案（或把那段话改通用）——这条值得单独开 issue。

限制也一并说清楚：`enforcement` 恒为 `partial`；受隔离的 **PTC 用不了**（它依赖 fd 7 的继承控制通道，而 MXC 的执行器契约是 JSON 请求文件，插件明确拒绝并说明原因，而不是静默丢弃）；需要 Windows 11 24H2+ 和自备的 MXC 载荷（解包约 105 MB）。
