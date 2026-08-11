param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "clean",
    "installed-n",
    "upgraded-n-plus-one",
    "same-version-reinstall",
    "downgrade-attempt",
    "uninstalled",
    "reinstalled-n-plus-one"
  )]
  [string]$Scenario,

  [Parameter(Mandatory = $true)]
  [string]$EvidenceDirectory,

  [string]$ExpectedVersion,
  [string]$ArtifactPath,
  [string]$ArtifactVersion,
  [string]$ExpectedSubject,
  [string]$DataDirectory,
  [string]$LogDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Windows VM evidence can only be captured on Windows"
}

$ProductName = "Codex Taskboard"
$Identifier = "com.chuspeeism.codex-taskboard"
$InstalledScenarios = @(
  "installed-n",
  "upgraded-n-plus-one",
  "same-version-reinstall",
  "downgrade-attempt",
  "reinstalled-n-plus-one"
)

function Assert-Version([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
    throw "$Label is missing or invalid"
  }
}

if ($Scenario -in $InstalledScenarios) {
  Assert-Version $ExpectedVersion "ExpectedVersion"
  Assert-Version $ArtifactVersion "ArtifactVersion"
  if ([string]::IsNullOrWhiteSpace($ArtifactPath)) {
    throw "ArtifactPath is required for $Scenario"
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedSubject)) {
    throw "ExpectedSubject is required for $Scenario"
  }
} elseif (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
  throw "ExpectedVersion is not valid for $Scenario"
}

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw "APPDATA is required to locate Codex Taskboard data"
  }
  $DataDirectory = Join-Path $env:APPDATA $Identifier
}
if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is required to locate Codex Taskboard logs"
  }
  $LogDirectory = Join-Path $env:LOCALAPPDATA "$Identifier\logs"
}

function String-Property($Object, [string]$Name) {
  $property = $Object.PSObject.Properties[$Name]
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
        key = $key.PSChildName
        displayName = String-Property $properties "DisplayName"
        displayVersion = String-Property $properties "DisplayVersion"
        publisher = String-Property $properties "Publisher"
        installLocation = String-Property $properties "InstallLocation"
        displayIcon = String-Property $properties "DisplayIcon"
        uninstallString = String-Property $properties "UninstallString"
        quietUninstallString = String-Property $properties "QuietUninstallString"
      }
    }
  }
  return @($entries | Sort-Object hive, key)
}

function Get-ArtifactEvidence {
  if ([string]::IsNullOrWhiteSpace($ArtifactPath)) {
    return $null
  }
  $resolved = (Resolve-Path -LiteralPath $ArtifactPath).Path
  $item = Get-Item -LiteralPath $resolved
  if ($item.Extension -ne ".exe") {
    throw "Windows VM artifact must be an .exe installer"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  $subject = if ($null -eq $signature.SignerCertificate) {
    $null
  } else {
    $signature.SignerCertificate.Subject
  }
  $timestampSubject = if ($null -eq $signature.TimeStamperCertificate) {
    $null
  } else {
    $signature.TimeStamperCertificate.Subject
  }
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Artifact Authenticode signature is not valid: $resolved ($($signature.Status))"
  }
  if ($subject -ne $ExpectedSubject) {
    throw "Artifact signer subject does not match ExpectedSubject: $resolved"
  }
  if ($null -eq $timestampSubject) {
    throw "Artifact Authenticode timestamp is missing: $resolved"
  }
  return [ordered]@{
    fileName = $item.Name
    artifactVersion = $ArtifactVersion
    length = $item.Length
    sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    signatureStatus = [string]$signature.Status
    signerSubject = $subject
    expectedSubject = $ExpectedSubject
    timestampPresent = $true
    timestampSubject = $timestampSubject
  }
}

function Get-FileMetadata([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [ordered]@{ exists = $false }
  }
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    exists = $true
    length = $item.Length
    sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
  }
}

function Get-ManagedProcesses {
  $result = @()
  foreach ($process in Get-CimInstance -ClassName Win32_Process) {
    $name = [string]$process.Name
    $commandLine = if ($null -eq $process.CommandLine) { "" } else { [string]$process.CommandLine }
    $managed = $name -ieq "codex-taskboard-launcher.exe"
    $managed = $managed -or ($name -ieq "node.exe" -and $commandLine -like "*codex-injector.mjs*")
    $managed = $managed -or ($name -ieq "ChatGPT.exe" -and $commandLine -like "*codex-profile*")
    if ($managed) {
      $result += [ordered]@{
        name = $name
        processId = [int]$process.ProcessId
        parentProcessId = [int]$process.ParentProcessId
        executablePath = if ($null -eq $process.ExecutablePath) { $null } else { [string]$process.ExecutablePath }
      }
    }
  }
  return @($result | Sort-Object name, processId)
}

$sentinelPath = Join-Path $DataDirectory ".windows-vm-matrix-sentinel.txt"
$updateStatePath = Join-Path $DataDirectory "windows-update-state.json"
$launcherLogPath = Join-Path $LogDirectory "codex-taskboard-launcher.log"
$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
$evidence = [ordered]@{
  schemaVersion = 1
  scenario = $Scenario
  capturedAt = [DateTime]::UtcNow.ToString("o")
  expectedVersion = if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { $null } else { $ExpectedVersion }
  os = [ordered]@{
    caption = [string]$operatingSystem.Caption
    version = [string]$operatingSystem.Version
    buildNumber = [string]$operatingSystem.BuildNumber
    architecture = [string]$operatingSystem.OSArchitecture
  }
  artifact = Get-ArtifactEvidence
  installationEntries = @(Get-TaskboardInstallEntries)
  data = [ordered]@{
    directoryExists = Test-Path -LiteralPath $DataDirectory -PathType Container
    sentinel = Get-FileMetadata $sentinelPath
    updateStateExists = Test-Path -LiteralPath $updateStatePath -PathType Leaf
    launcherLog = Get-FileMetadata $launcherLogPath
  }
  managedProcesses = @(Get-ManagedProcesses)
}

[System.IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
$outputPath = Join-Path $EvidenceDirectory "$Scenario.json"
$json = $evidence | ConvertTo-Json -Depth 8
$encoding = [System.Text.UTF8Encoding]::new($false)
$stream = [System.IO.File]::Open(
  $outputPath,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::None
)
try {
  $writer = [System.IO.StreamWriter]::new($stream, $encoding)
  try {
    $writer.WriteLine($json)
  } finally {
    $writer.Dispose()
  }
} finally {
  $stream.Dispose()
}

Write-Host "Captured read-only Windows VM evidence: $outputPath"
