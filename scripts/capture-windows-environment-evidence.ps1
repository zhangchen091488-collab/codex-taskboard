param(
  [Parameter(Mandatory = $true)]
  [string]$EvidenceDirectory,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")]
  [string]$SnapshotLabel,

  [Parameter(Mandatory = $true)]
  [switch]$ResetProcedureReviewed,

  [string]$ProjectRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Windows environment evidence can only be captured on Windows"
}
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$repoCommit = (& git -C $resolvedProjectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $repoCommit -notmatch "^[0-9a-f]{40}$") {
  throw "Could not resolve the reviewed repository commit"
}

$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0) { throw "Node version probe failed" }
$cargoVersion = (& cargo --version).Trim()
if ($LASTEXITCODE -ne 0) { throw "Cargo version probe failed" }
$gitVersion = (& git --version).Trim()
if ($LASTEXITCODE -ne 0) { throw "Git version probe failed" }

$packages = @(Get-AppxPackage -Name "OpenAI.Codex" | Sort-Object Version -Descending)
if ($packages.Count -lt 1) {
  throw "The official OpenAI.Codex package is not installed for the current user"
}
$package = $packages[0]
$codexExecutable = Join-Path $package.InstallLocation "app\ChatGPT.exe"
$sourceProfile = Join-Path $env:APPDATA "Codex"
$independentProfile = Join-Path `
  $env:APPDATA `
  "com.chuspeeism.codex-taskboard\codex-profile"
$sourceFull = [IO.Path]::GetFullPath($sourceProfile).TrimEnd("\") + "\"
$independentFull = [IO.Path]::GetFullPath($independentProfile).TrimEnd("\") + "\"
$overlap = $sourceFull.StartsWith($independentFull, [StringComparison]::OrdinalIgnoreCase) -or
  $independentFull.StartsWith($sourceFull, [StringComparison]::OrdinalIgnoreCase)

$evidence = [ordered]@{
  schemaVersion = 1
  kind = "environment"
  capturedAt = [DateTime]::UtcNow.ToString("o")
  repoCommit = $repoCommit
  snapshotLabel = $SnapshotLabel
  os = [ordered]@{
    caption = [string]$operatingSystem.Caption
    architecture = [string]$operatingSystem.OSArchitecture
    buildNumber = [string]$operatingSystem.BuildNumber
  }
  account = [ordered]@{ isAdministrator = $isAdministrator }
  tools = [ordered]@{
    node = $nodeVersion
    cargo = $cargoVersion
    git = $gitVersion
  }
  codexPackage = [ordered]@{
    name = [string]$package.Name
    publisher = [string]$package.Publisher
    familyName = [string]$package.PackageFamilyName
    version = $package.Version.ToString()
    executableExists = Test-Path -LiteralPath $codexExecutable -PathType Leaf
  }
  profiles = [ordered]@{
    sourceExists = Test-Path -LiteralPath $sourceProfile -PathType Container
    sourceAndIndependentOverlap = $overlap
  }
  resetProcedureReviewed = [bool]$ResetProcedureReviewed
}

[IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
$outputPath = Join-Path $EvidenceDirectory "environment.json"
$json = $evidence | ConvertTo-Json -Depth 6
$encoding = [Text.UTF8Encoding]::new($false)
$stream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
  $writer = [IO.StreamWriter]::new($stream, $encoding)
  try {
    $writer.WriteLine($json)
  } finally {
    $writer.Dispose()
  }
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
Write-Host "Captured sanitized Windows environment evidence: environment.json"
