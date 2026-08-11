# Windows 11 x64 安装与故障处理

## 当前状态

Windows 11 x64 的应用、current-user NSIS、WebView2、进程树、`taskctl` 和
updater 代码已经进入实现后验证阶段。正式 Windows 安装包尚未发布；受保护的
Windows release job 和真实 Windows VM 证据仍是发布闸门。

只使用发布负责人提供的签名候选包做验收。不要安装 unsigned CI setup，不要从
Draft Release 向普通用户分发安装包，也不要把本文件视为 Windows 已正式发布的
声明。

## 系统要求

- Windows 11 x64，使用普通用户账户安装；安装器模式是 `currentUser`，不应要求
  管理员权限。
- 官方 Codex Windows App。启动器按 Microsoft Store 包身份发现产品
  `9PLM9XGG6VKS`；自动发现失败时会提示选择 `ChatGPT.exe`。
- Evergreen WebView2 Runtime。安装器使用 `downloadBootstrapper`；如果系统没有
  WebView2，安装时必须联网。该 setup 不是离线安装包。
- 日常运行不需要系统 Node.js、Rust、Git 或本仓库；安装包自带 Node.js
  22.23.2、服务、界面、注入器和 `taskctl`。

WebView2 的联网/离线行为和验证矩阵见
[Windows WebView2 分发策略](windows-webview2-policy.md)。

## 验证并安装候选包

在 PowerShell 中先检查候选 setup。`Status` 必须是 `Valid`，必须有 signer 和
timestamp certificate；signer subject 必须与发布负责人通过独立渠道给出的精确
值一致。

```powershell
$Installer = "C:\installers\Codex Taskboard_0.2.2_x64-setup.exe"
$Signature = Get-AuthenticodeSignature -LiteralPath $Installer
$Signature | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate

if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Invalid Authenticode signature"
}
if ($null -eq $Signature.SignerCertificate) { throw "Missing signer certificate" }
if ($null -eq $Signature.TimeStamperCertificate) { throw "Missing timestamp" }
```

双击 setup 完成交互式安装。自动化验收可使用大写 `/S` 静默安装，但普通用户安装
应保留交互界面。安装完成后从开始菜单启动 Codex Taskboard；它在系统托盘运行，
不显示独立主窗口。

启动器不会修改官方 Codex 的文件。它创建独立 profile，启动一个受 Job Object
管理的 Codex 进程树，等待私有 CDP pipe 就绪，再注入任务面板。自动发现失败时，
按提示选择官方 `ChatGPT.exe`；只有手动选择会写入持久记录。

不要在文档或脚本中猜固定安装目录。NSIS 把实际 `InstallLocation` 写入当前用户的
卸载注册表项，可这样读取：

```powershell
$Entries = @(
  Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" |
    Get-ItemProperty |
    Where-Object DisplayName -eq "Codex Taskboard"
)
if ($Entries.Count -ne 1) { throw "Expected one Codex Taskboard install entry" }
$InstallDirectory = $Entries[0].InstallLocation
$InstallDirectory
```

## 数据、配置和日志

安装、升级、同版本重装和卸载都应保留下列用户数据。卸载后只有在已备份且明确要
清空任务数据时才手动处理数据目录。

| 内容 | Windows 路径 |
| --- | --- |
| SQLite 数据库 | `%APPDATA%\com.chuspeeism.codex-taskboard\taskboard.sqlite` |
| 附件 | `%APPDATA%\com.chuspeeism.codex-taskboard\attachments\` |
| 云端配对和项目映射 | `%APPDATA%\com.chuspeeism.codex-taskboard\cloud-companion.json` |
| 自动化策略 | `%APPDATA%\com.chuspeeism.codex-taskboard\codex-automation-policies.json` |
| 独立 Codex profile | `%APPDATA%\com.chuspeeism.codex-taskboard\codex-profile\` |
| 手动选择的 Codex 位置 | `%APPDATA%\com.chuspeeism.codex-taskboard\windows-codex-installation.json` |
| 当前服务描述 | `%APPDATA%\com.chuspeeism.codex-taskboard\launcher-runtime.json` |
| 启动日志 | `%LOCALAPPDATA%\com.chuspeeism.codex-taskboard\logs\codex-taskboard-launcher.log` |

`launcher-child.json`、`launcher-runtime.json` 和
`transport-readiness-<nonce>.json` 是运行期记录。`windows-update-state.json` 只在
接受更新、准备安装到下一次启动恢复之间短暂存在；稳定状态不应残留该文件。
不要复制运行期 token、secret 或完整 profile 到问题报告。

## 自动更新与回滚

App 每次启动检查一次已发布的 `latest.json`。Windows 条目是
`windows-x86_64`，指向 Authenticode 签名的 canonical NSIS setup；Tauri updater
还会用 App 内置公钥验证 setup 的 `.sig`。Authenticode 和 updater 签名是两个
独立闸门，不能相互替代。

用户接受更新后，启动器先原子写入更新意图，再停止受管进程树并安装。下载、签名
验证或安装失败时，启动器尝试恢复任务面板服务并清理更新意图；下一次启动会消费
残留意图并显示恢复结果。`allowDowngrades` 为 `false`，旧版本 setup 必须拒绝覆盖
较新版本。

不要通过覆盖安装更低版本来“回滚”。保留 `%APPDATA%` 数据，修复后发布更高的
补丁版本。完整的升级、同版本重装、降级拒绝、卸载与重装步骤见
[Windows VM 验收矩阵](windows-vm-validation.md)。

## 使用 `taskctl`

先启动 Codex Taskboard，确认托盘菜单可用，再读取注册表中的安装目录并调用打包的
wrapper：

```powershell
$Entry = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" |
  Get-ItemProperty |
  Where-Object DisplayName -eq "Codex Taskboard" |
  Select-Object -First 1
& (Join-Path $Entry.InstallLocation "bin\taskctl.cmd") project list
```

wrapper 使用安装目录中的 `node.exe`，把参数和退出码原样传给 CLI，并从
`launcher-runtime.json` 发现随机 loopback 端口。若启动器未运行或 runtime record
已失效，`taskctl` 会失败；先从托盘重新启动 Codex，而不是把端口硬编码到脚本。

## 只读诊断

以下命令不修改应用数据：

```powershell
$DataDirectory = Join-Path $env:APPDATA "com.chuspeeism.codex-taskboard"
$LogPath = Join-Path $env:LOCALAPPDATA `
  "com.chuspeeism.codex-taskboard\logs\codex-taskboard-launcher.log"

Get-Item -LiteralPath $DataDirectory
Get-Content -LiteralPath $LogPath -Tail 200
Get-CimInstance Win32_Process |
  Where-Object Name -in @("codex-taskboard-launcher.exe", "node.exe", "ChatGPT.exe") |
  Select-Object Name, ProcessId, ParentProcessId, ExecutablePath
```

提交问题时可附版本、Windows build number、setup SHA-256、签名状态、去敏后的日志
末尾和是否存在 `windows-update-state.json`。不要上传数据库、附件、Codex profile、
证书/PFX、签名密码、updater 私钥、runtime token 或 secret。

常见问题：

- 缺少 WebView2 且离线：联网重试或先由管理员部署 Evergreen WebView2；不要把失败
  安装当成可运行的离线版本。
- 找不到官方 Codex：确认 Microsoft Store 产品已安装；移动过手动选择的文件时，
  从托盘重试并重新选择。`CODEX_TASKBOARD_CODEX_APP` 只用于受控诊断，错误 override
  会失败关闭，不会静默回退。
- `taskctl` 无法连接：先确认启动器和其 `node.exe` 仍在运行，再检查日志和
  `launcher-runtime.json`；不要手改 runtime record。
- 更新后异常：保留数据，记录 update state 是否在下一次启动被消费，使用托盘重新
  启动；不要删除整个 `%APPDATA%` 目录作为首选修复。

## Windows 开发与验收

开发机需要 Node.js 22、Rust 1.88、`x86_64-pc-windows-msvc` target 和 Visual
Studio Build Tools C++ 工具链：

```powershell
npm ci
npm run typecheck
npm run build:web
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
npm run app:build:windows
```

`app:build:windows` 生成 unsigned、仅用于 CI/本机验收的 NSIS。受保护签名构建所需
的 PFX、timestamp 和 updater 私钥边界见
[Windows Authenticode 策略](windows-signing-policy.md) 与
[Windows updater 资产契约](windows-updater-assets.md)；不要把 secret 放入仓库、
`.env`、命令参数或测试证据。
