# Windows 11 本机运行验收

## 范围与边界

这份手册用于在普通用户的 Windows 11 x64 环境补齐 `WIN-001`–`WIN-008`
运行证据。整个过程由用户在 Windows 本机操作，不需要远程桌面，也不会由脚本安装、
停止或强制结束进程。传输探针只执行 `1 + 1` 和一个立即移除的 DOM marker，不运行
完整任务面板注入器。

使用一次性的干净 VM 快照和新建的空证据目录。证据文件均使用 create-only 写入；
失败后从快照恢复并改用新的证据目录，不要覆盖或手改旧结果。运行前关闭官方 Codex
和 Codex Taskboard，并确认检出的提交就是待审核提交。

环境要求：

- Windows 11 x64 普通用户，不能使用管理员终端；
- 官方 Microsoft Store `OpenAI.Codex` 已启动过一次，随后完全退出；
- Node.js 22、Rust/Cargo 1.88、Git 和 MSVC Rust target 已安装；
- 仓库依赖已用 `npm ci` 安装，候选安装包版本与仓库 `package.json` 一致；
- 已阅读 VM 快照恢复步骤，失败时可以回到相同干净起点。

## 1. 建立本次证据目录

在仓库根目录打开普通 PowerShell：

```powershell
$Repo = (Resolve-Path .).Path
$Commit = (& git -C $Repo rev-parse HEAD).Trim()
$AppVersion = (Get-Content (Join-Path $Repo "package.json") -Raw |
  ConvertFrom-Json).version
$Evidence = Join-Path $env:TEMP "codex-taskboard-runtime-$($Commit.Substring(0, 12))"
if (Test-Path -LiteralPath $Evidence) { throw "Choose a new empty evidence directory" }
New-Item -ItemType Directory -Path $Evidence | Out-Null

$Package = Get-AppxPackage -Name "OpenAI.Codex" |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ($null -eq $Package) { throw "OpenAI.Codex is not installed for this user" }
$CodexExe = Join-Path $Package.InstallLocation "app\ChatGPT.exe"
$SourceProfile = Join-Path $env:APPDATA "Codex"
```

若 `$Evidence` 已存在或里面有文件，停止本次操作并选择一个新目录。不要清空或复用
旧证据目录。

## 2. 采集环境基线

```powershell
& (Join-Path $Repo "scripts\capture-windows-environment-evidence.ps1") `
  -EvidenceDirectory $Evidence `
  -SnapshotLabel "win11-clean-standard-user" `
  -ResetProcedureReviewed
```

该步骤只记录 Windows build、是否为管理员、工具版本、官方包身份和路径存在性布尔
值，不输出安装路径、用户目录或 profile 内容。若普通用户、Node 22、Cargo 1.88、
官方包身份或 source profile 不符合要求，立即停止。

## 3. 验证三种 Codex 传输

再次确认官方 Codex 和 Codex Taskboard 均已退出，然后运行：

```powershell
npm run app:probe:windows-runtime -- "$CodexExe" "$SourceProfile" "$Evidence"
```

探针会依次打开三个使用随机临时 profile 的 Codex 窗口：动态 loopback 端口
`port=0`、随机固定 loopback 端口和私有 CDP pipe。每次控制台显示 ready 后，使用
Codex 窗口自身的关闭按钮正常退出；不要在任务管理器中结束探针进程。第三个窗口中
会写入一个 marker 并立即删除，前两个窗口只执行无副作用表达式。

成功时会生成 `transport-probe.json`，并证明：

- 三个 transport 都找到正式 Codex page target，且 `1 + 1` 返回 `2`；
- 调试端口只绑定 `127.0.0.1`，pipe 不开放网络端口；
- marker 已移除，三个临时 profile 和对应进程均无残留；
- 官方 source profile 的元数据指纹和文件计数前后一致。

探针不读取 profile 文件内容，也不会保存真实路径、端口、命令行或凭据。

## 4. 采集正式集成运行状态

按 [Windows 安装与故障处理](windows-installation.md) 验证 Authenticode 并安装同版本
候选包。从开始菜单启动 Codex Taskboard，等待独立 Codex 窗口出现，确认任务面板
侧栏已加载且可读取项目列表，然后执行：

```powershell
& (Join-Path $Repo "scripts\capture-windows-production-evidence.ps1") `
  -Scenario running `
  -EvidenceDirectory $Evidence `
  -AppVersion $AppVersion `
  -ConfirmSidebarReady `
  -ConfirmUpstreamUnmodified
```

采集器会验证 current-user 安装记录、打包的 `taskctl.cmd`、随机 loopback 服务端口、
Windows Job Object、独立 `--user-data-dir`、私有 CDP pipe 和最近一次启动日志。侧栏
就绪来自本次人工观察，不伪装成不存在的 Windows 注入器日志。

## 5. 按固定顺序执行清理场景

每个场景结束后先在任务管理器“详细信息”页确认受管 `node.exe` 和使用 Taskboard
独立 profile 的 `ChatGPT.exe` 已消失，再运行对应采集命令。不要结束官方 Codex、
其他 Node 进程或无关应用。

### 5.1 正常退出

使用独立 Codex 窗口自身的关闭按钮退出。保留 Codex Taskboard 托盘进程，等待受管
子进程清理完成：

```powershell
& (Join-Path $Repo "scripts\capture-windows-production-evidence.ps1") `
  -Scenario normal-exit `
  -EvidenceDirectory $Evidence `
  -AppVersion $AppVersion `
  -ConfirmScenarioObserved `
  -ConfirmNoUnrelatedTermination
```

### 5.2 Codex 异常退出与恢复

从托盘选择“重新启动 Codex”。待侧栏再次就绪后，只在任务管理器中结束命令行包含
Taskboard 独立 `codex-profile` 的 `ChatGPT.exe`。确认应用自动恢复一次；随后用恢复后
Codex 窗口的关闭按钮正常退出，并等待全部受管子进程消失：

```powershell
& (Join-Path $Repo "scripts\capture-windows-production-evidence.ps1") `
  -Scenario forced-exit `
  -EvidenceDirectory $Evidence `
  -AppVersion $AppVersion `
  -ConfirmScenarioObserved `
  -ConfirmNoUnrelatedTermination
```

### 5.3 父进程退出

再次从托盘选择“重新启动 Codex”，确认侧栏就绪，然后从 Codex Taskboard 托盘菜单
选择“退出”。等待托盘图标、启动器和全部受管子进程消失：

```powershell
& (Join-Path $Repo "scripts\capture-windows-production-evidence.ps1") `
  -Scenario parent-exit `
  -EvidenceDirectory $Evidence `
  -AppVersion $AppVersion `
  -ConfirmScenarioObserved `
  -ConfirmNoUnrelatedTermination
```

脚本会在每个清理场景中执行限定范围的 Windows Rust 生命周期测试，但不会代替上述
人工场景，也不会停止任何进程。

## 6. 离线验证与交接

目录中必须恰好形成这六项本次提交的证据：

```text
environment.json
transport-probe.json
production-running.json
production-normal-exit.json
production-forced-exit.json
production-parent-exit.json
```

执行统一验证：

```powershell
npm run app:verify:windows-runtime -- "$Evidence"
```

只有输出中的 `decision` 为 `go`，且六个文件的 commit、App 版本一致，才能把
`WIN-001`–`WIN-008` 的运行门从 `BLOCKED` 移交审核。验证失败时保留原目录，记录失败
步骤并从干净快照重做；不要通过编辑 JSON 使验证器通过。

交接时只提供这六个去敏 JSON、测试命令结果和候选包 SHA-256。不要附带数据库、
附件、日志全文、官方/独立 Codex profile、真实用户路径、runtime token、证书或签名
密钥。这份运行证据不替代签名安装器、自动更新和双平台 Release 的独立验收门。
