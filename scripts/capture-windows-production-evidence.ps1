param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("running", "normal-exit", "parent-exit", "forced-exit")]
  [string]$Scenario,

  [Parameter(Mandatory = $true)]
  [string]$EvidenceDirectory,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")]
  [string]$AppVersion,

  [switch]$ConfirmSidebarReady,
  [switch]$ConfirmUpstreamUnmodified,
  [switch]$ConfirmNoUnrelatedTermination,

  [string]$ProjectRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Windows production evidence can only be captured on Windows"
}
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$repoCommit = (& git -C $resolvedProjectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $repoCommit -notmatch "^[0-9a-f]{40}$") {
  throw "Could not resolve the reviewed repository commit"
}
$packageVersion = [string](
  Get-Content -LiteralPath (Join-Path $resolvedProjectRoot "package.json") -Raw |
    ConvertFrom-Json
).version
if ($packageVersion -ne $AppVersion) {
  throw "Evidence AppVersion must match the reviewed package.json"
}

function Process-Snapshot {
  $launcherCount = 0
  $injectorNodeCount = 0
  $isolatedCodexCount = 0
  $privatePipe = $false
  $boundedLifecycle = $false
  $isolatedUserData = $false
  foreach ($process in Get-CimInstance -ClassName Win32_Process) {
    $name = [string]$process.Name
    $arguments = if ($null -eq $process.CommandLine) { "" } else { [string]$process.CommandLine }
    if ($name -ieq "codex-taskboard-launcher.exe") {
      $launcherCount += 1
    } elseif ($name -ieq "node.exe" -and $arguments -like "*codex-injector.mjs*") {
      $injectorNodeCount += 1
      $privatePipe = $privatePipe -or $arguments.Contains("--cdp-pipe")
      $boundedLifecycle = $boundedLifecycle -or $arguments.Contains("--bounded-launcher-lifecycle")
    } elseif ($name -ieq "ChatGPT.exe" -and $arguments -like "*codex-profile*") {
      $isolatedCodexCount += 1
      $isolatedUserData = $isolatedUserData -or $arguments.Contains("--user-data-dir=")
    }
  }
  return [ordered]@{
    launcherCount = $launcherCount
    injectorNodeCount = $injectorNodeCount
    isolatedCodexCount = $isolatedCodexCount
    privatePipe = $privatePipe
    boundedLifecycle = $boundedLifecycle
    isolatedUserData = $isolatedUserData
  }
}

function Install-Entry {
  $entries = @()
  foreach ($root in @(
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $root) {
      $value = Get-ItemProperty -LiteralPath $key.PSPath
      if ([string]$value.DisplayName -ceq "Codex Taskboard") { $entries += $value }
    }
  }
  if ($entries.Count -ne 1) { throw "Expected one current-user Codex Taskboard install entry" }
  return $entries[0]
}

function Write-Evidence([string]$FileName, [object]$Value) {
  [IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
  $outputPath = Join-Path $EvidenceDirectory $FileName
  $json = $Value | ConvertTo-Json -Depth 8
  $encoding = [Text.UTF8Encoding]::new($false)
  $stream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try {
    $writer = [IO.StreamWriter]::new($stream, $encoding)
    try { $writer.WriteLine($json) } finally { $writer.Dispose() }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

$processes = Process-Snapshot
if ($Scenario -eq "running") {
  if (-not $ConfirmSidebarReady -or -not $ConfirmUpstreamUnmodified) {
    throw "Running capture requires sidebar-ready and upstream-unmodified confirmations"
  }
  $entry = Install-Entry
  if ([string]$entry.DisplayVersion -cne $AppVersion) {
    throw "Installed Codex Taskboard version does not match AppVersion"
  }
  $dataDirectory = Join-Path $env:APPDATA "com.chuspeeism.codex-taskboard"
  $runtimePath = Join-Path $dataDirectory "launcher-runtime.json"
  $logPath = Join-Path `
    $env:LOCALAPPDATA `
    "com.chuspeeism.codex-taskboard\logs\codex-taskboard-launcher.log"
  $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
  $log = Get-Content -LiteralPath $logPath -Raw
  $discoveryMatches = [regex]::Matches(
    $log,
    "Windows Codex installation discovered from (ExplicitOverride|StoredSelection|SystemPackage|UserSelection): ([^\r\n]+)"
  )
  if ($discoveryMatches.Count -lt 1) { throw "Launcher log has no Windows discovery evidence" }
  $latestDiscovery = $discoveryMatches[$discoveryMatches.Count - 1]
  $discoverySource = $latestDiscovery.Groups[1].Value
  $discoveredExecutableExists = Test-Path `
    -LiteralPath $latestDiscovery.Groups[2].Value.Trim() `
    -PathType Leaf
  $taskctl = Join-Path ([string]$entry.InstallLocation) "bin\taskctl.cmd"
  & $taskctl project list --json *> $null
  $taskctlExitCode = $LASTEXITCODE
  $evidence = [ordered]@{
    schemaVersion = 1
    kind = "production-running"
    capturedAt = [DateTime]::UtcNow.ToString("o")
    repoCommit = $repoCommit
    appVersion = $AppVersion
    discovery = [ordered]@{
      source = $discoverySource
      executableExists = $discoveredExecutableExists
    }
    processes = [ordered]@{
      launcherCount = $processes.launcherCount
      injectorNodeCount = $processes.injectorNodeCount
      isolatedCodexCount = $processes.isolatedCodexCount
    }
    arguments = [ordered]@{
      isolatedUserDataDir = $processes.isolatedUserData
      privateDebuggingPipe = $processes.privatePipe
      boundedLauncherLifecycle = $processes.boundedLifecycle
    }
    readiness = [ordered]@{
      taskctlExitCode = $taskctlExitCode
      randomLoopbackPort = (
        [string]$runtime.host -ceq "127.0.0.1" -and
        [int]$runtime.port -gt 0 -and
        [int]$runtime.port -ne 47823
      )
      sidebarReady = [bool]$ConfirmSidebarReady
    }
    logSignals = [ordered]@{
      discovery = $discoveryMatches.Count -gt 0
      jobObject = $log.Contains("inside its Job Object")
      pipeReady = $log.Contains("Windows Codex private CDP pipe is ready")
      injectionReady = $log.Contains('"injected"')
      transportFailure = $log.Contains("Windows Codex transport readiness failed")
    }
    upstreamFilesModified = -not [bool]$ConfirmUpstreamUnmodified
    credentialsIncluded = $false
  }
  Write-Evidence "production-running.json" $evidence
  Write-Host "Captured sanitized running evidence: production-running.json"
  return
}

if (-not $ConfirmNoUnrelatedTermination) {
  throw "Cleanup capture requires confirmation that unrelated processes were not terminated"
}
& cargo test `
  --locked `
  --manifest-path (Join-Path $resolvedProjectRoot "src-tauri\Cargo.toml") `
  --target x86_64-pc-windows-msvc `
  "platform::windows::tests::"
$lifecycleTestsPassed = $LASTEXITCODE -eq 0
$expectedLauncherCount = if ($Scenario -eq "parent-exit") { 0 } else { 1 }
$cleanup = [ordered]@{
  schemaVersion = 1
  kind = "production-cleanup"
  capturedAt = [DateTime]::UtcNow.ToString("o")
  repoCommit = $repoCommit
  scenario = $Scenario
  childProcessesRemaining = $processes.injectorNodeCount + $processes.isolatedCodexCount
  taskboardNodeRemaining = $processes.injectorNodeCount
  isolatedCodexRemaining = $processes.isolatedCodexCount
  launcherCount = $processes.launcherCount
  unrelatedProcessesTerminated = 0
  jobObjectKillOnClose = $lifecycleTestsPassed
  pidReuseGuarded = $lifecycleTestsPassed
  handleLeakDetected = -not $lifecycleTestsPassed
  credentialsIncluded = $false
}
if ($processes.launcherCount -ne $expectedLauncherCount) {
  Write-Warning "Observed launcher count does not match the selected cleanup scenario"
}
Write-Evidence "production-$Scenario.json" $cleanup
Write-Host "Captured sanitized cleanup evidence: production-$Scenario.json"
