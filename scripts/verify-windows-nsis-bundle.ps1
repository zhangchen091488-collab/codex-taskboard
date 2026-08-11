param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,

  [string]$ProjectRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Unsigned NSIS bundle verification requires Windows"
}
if ($env:GITHUB_ACTIONS -ne "true" -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw "Unsigned NSIS install/uninstall verification is restricted to an ephemeral GitHub runner"
}
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "ExpectedVersion must use major.minor.patch"
}

$ProductName = "Codex Taskboard"

function String-Property([AllowNull()]$InputObject, [string]$Name) {
  if ($null -eq $InputObject) {
    return $null
  }
  $property = [System.Management.Automation.PSObject]::AsPSObject($InputObject).Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $null
  }
  return [string]$property.Value
}

function Get-TaskboardInstallEntries {
  $roots = @(
    @{ hive = "HKCU"; path = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall" },
    @{ hive = "HKCU"; path = "Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" },
    @{ hive = "HKLM"; path = "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall" },
    @{ hive = "HKLM"; path = "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" }
  )
  $entries = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root.path)) {
      continue
    }
    foreach ($key in Get-ChildItem -LiteralPath $root.path -ErrorAction Stop) {
      $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      if ((String-Property $properties "DisplayName") -ne $ProductName) {
        continue
      }
      $entries += [ordered]@{
        hive = $root.hive
        registryPath = $key.PSPath
        displayVersion = String-Property $properties "DisplayVersion"
        installLocation = String-Property $properties "InstallLocation"
        uninstallString = String-Property $properties "UninstallString"
      }
    }
  }
  return @($entries)
}

function Resolve-Uninstaller($Entry, [string]$InstallDirectory) {
  $command = $Entry.uninstallString
  if ([string]::IsNullOrWhiteSpace($command)) {
    throw "Installed NSIS entry has no UninstallString"
  }
  $candidate = $null
  if ($command -match '^"([^"]+\.exe)"(?:\s.*)?$') {
    $candidate = $Matches[1]
  } elseif ($command -match '^(.+?\.exe)(?:\s.*)?$') {
    $candidate = $Matches[1]
  }
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    throw "Could not parse the installed NSIS UninstallString"
  }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $installRoot = [System.IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\'
  if (-not [System.IO.Path]::GetFullPath($resolved).StartsWith(
    $installRoot,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Refusing to execute an uninstaller outside the verified install directory"
  }
  return $resolved
}

function File-Evidence([string]$InstalledPath, [string]$SourcePath) {
  $installed = (Resolve-Path -LiteralPath $InstalledPath).Path
  $source = (Resolve-Path -LiteralPath $SourcePath).Path
  $installedHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant()
  $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedHash -ne $sourceHash) {
    throw "Installed bundle file differs from staged source: $InstalledPath"
  }
  return [ordered]@{
    relativePath = [System.IO.Path]::GetRelativePath($InstallDirectory, $installed)
    length = (Get-Item -LiteralPath $installed).Length
    sha256 = $installedHash
  }
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$resolvedSetup = (Resolve-Path -LiteralPath $SetupPath).Path
$setupItem = Get-Item -LiteralPath $resolvedSetup
if ($setupItem.Extension -ne ".exe") {
  throw "NSIS artifact must be an .exe"
}
$header = [System.IO.File]::ReadAllBytes($resolvedSetup)[0..1]
if ($header[0] -ne 0x4d -or $header[1] -ne 0x5a) {
  throw "NSIS artifact is not a PE executable"
}
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedSetup
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
  throw "PR NSIS artifact must be unsigned, got $($signature.Status)"
}
if ((Get-TaskboardInstallEntries).Count -ne 0) {
  throw "Runner is not clean: Codex Taskboard is already installed"
}

$InstallDirectory = $null
$installedEntry = $null
$installedFiles = @()
$installAttempted = $false
$uninstallCompleted = $false
try {
  $installAttempted = $true
  $installer = Start-Process -FilePath $resolvedSetup -ArgumentList "/S" -PassThru -Wait
  if ($installer.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($installer.ExitCode)"
  }

  $entries = @(Get-TaskboardInstallEntries)
  if ($entries.Count -ne 1) {
    throw "Expected one Codex Taskboard install entry, found $($entries.Count)"
  }
  $installedEntry = $entries[0]
  if ($installedEntry.hive -ne "HKCU") {
    throw "Unsigned NSIS must install only for the current user"
  }
  if ($installedEntry.displayVersion -ne $ExpectedVersion) {
    throw "Installed version mismatch: $($installedEntry.displayVersion)"
  }

  $InstallDirectory = $installedEntry.installLocation
  if ([string]::IsNullOrWhiteSpace($InstallDirectory)) {
    throw "Installed NSIS entry has no InstallLocation"
  }
  $InstallDirectory = (Resolve-Path -LiteralPath $InstallDirectory).Path
  $expectedFiles = @(
    @{
      installed = "codex-taskboard-launcher.exe"
      source = "src-tauri\target\x86_64-pc-windows-msvc\release\codex-taskboard-launcher.exe"
    },
    @{
      installed = "node.exe"
      source = "src-tauri\binaries\node-x86_64-pc-windows-msvc.exe"
    },
    @{ installed = "app\server\index.mjs"; source = "src-tauri\resources\app\server\index.mjs" },
    @{ installed = "bin\taskctl.cmd"; source = "src-tauri\resources\bin\taskctl.cmd" }
  )
  foreach ($expected in $expectedFiles) {
    $installedFiles += File-Evidence `
      (Join-Path $InstallDirectory $expected.installed) `
      (Join-Path $resolvedProjectRoot $expected.source)
  }
  $nodeVersion = & (Join-Path $InstallDirectory "node.exe") --version
  if ($nodeVersion -ne "v22.23.2") {
    throw "Installed Node sidecar version mismatch: $nodeVersion"
  }

  $uninstaller = Resolve-Uninstaller $installedEntry $InstallDirectory
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) {
    throw "NSIS uninstaller exited with code $($uninstall.ExitCode)"
  }
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    if ((Get-TaskboardInstallEntries).Count -eq 0 -and -not (Test-Path -LiteralPath $InstallDirectory)) {
      $uninstallCompleted = $true
      break
    }
    Start-Sleep -Milliseconds 200
  }
  if (-not $uninstallCompleted) {
    throw "NSIS uninstall left its registry entry or install directory behind"
  }

  $evidence = [ordered]@{
    schemaVersion = 1
    expectedVersion = $ExpectedVersion
    setup = [ordered]@{
      fileName = $setupItem.Name
      length = $setupItem.Length
      sha256 = (Get-FileHash -LiteralPath $resolvedSetup -Algorithm SHA256).Hash.ToLowerInvariant()
      signatureStatus = [string]$signature.Status
    }
    install = [ordered]@{
      hive = $installedEntry.hive
      displayVersion = $installedEntry.displayVersion
      files = $installedFiles
      nodeVersion = $nodeVersion
    }
    uninstall = [ordered]@{
      registryEntryRemoved = $true
      installDirectoryRemoved = $true
    }
  }
  $evidenceParent = Split-Path -Parent $EvidencePath
  if (-not [string]::IsNullOrWhiteSpace($evidenceParent)) {
    [System.IO.Directory]::CreateDirectory($evidenceParent) | Out-Null
  }
  $json = $evidence | ConvertTo-Json -Depth 8
  $encoding = [System.Text.UTF8Encoding]::new($false)
  $stream = [System.IO.File]::Open(
    $EvidencePath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $writer = [System.IO.StreamWriter]::new($stream, $encoding)
    try { $writer.WriteLine($json) } finally { $writer.Dispose() }
  } finally {
    $stream.Dispose()
  }
  Write-Host "Verified unsigned NSIS install and uninstall: $resolvedSetup"
} finally {
  if ($installAttempted -and -not $uninstallCompleted) {
    $remaining = @(Get-TaskboardInstallEntries)
    if ($remaining.Count -eq 1 -and $remaining[0].hive -eq "HKCU") {
      $cleanupDirectory = $remaining[0].installLocation
      if (-not [string]::IsNullOrWhiteSpace($cleanupDirectory)) {
        try {
          $cleanup = Resolve-Uninstaller $remaining[0] $cleanupDirectory
          $cleanupProcess = Start-Process -FilePath $cleanup -ArgumentList "/S" -PassThru -Wait
          Write-Host "Cleanup uninstaller exit code: $($cleanupProcess.ExitCode)"
        } catch {
          Write-Warning "Could not clean up failed NSIS verification: $($_.Exception.Message)"
        }
      }
    }
  }
}
