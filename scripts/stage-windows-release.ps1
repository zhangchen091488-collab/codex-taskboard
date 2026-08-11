param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$ReleaseTag,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedSubject,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $resolvedOutputDirectory) {
  throw "Windows release staging directory must not already exist"
}

$packagePath = Join-Path $resolvedProjectRoot "package.json"
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([String]::IsNullOrWhiteSpace($version) -or $ReleaseTag -ne "v$version") {
  throw "Release tag does not match package.json version"
}

$targetRoot = Join-Path `
  $resolvedProjectRoot `
  "src-tauri\target\x86_64-pc-windows-msvc\release"
$applicationPath = Join-Path $targetRoot "codex-taskboard-launcher.exe"
if (-not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) {
  throw "Signed Windows application executable is missing"
}
$nsisRoot = Join-Path $targetRoot "bundle\nsis"
$setups = @(Get-ChildItem -LiteralPath $nsisRoot -Filter "*-setup.exe" -File)
if ($setups.Count -ne 1) {
  throw "Expected exactly one Windows NSIS setup, found $($setups.Count)"
}
$setupPath = $setups[0].FullName
$signaturePath = "$setupPath.sig"
if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
  throw "Tauri updater signature is missing beside the NSIS setup"
}

$authenticodeVerifier = Join-Path $PSScriptRoot "verify-windows-authenticode.ps1"
$tamperVerifier = Join-Path $PSScriptRoot "test-windows-authenticode-tamper.ps1"
& $authenticodeVerifier `
  -ExpectedSubject $ExpectedSubject `
  -ArtifactPath @($applicationPath, $setupPath)
& $tamperVerifier `
  -ExpectedSubject $ExpectedSubject `
  -ArtifactPath $setupPath

$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$updaterProducer = Join-Path $PSScriptRoot "create-windows-updater.mjs"
& $node $updaterProducer $setupPath $resolvedOutputDirectory $ReleaseTag
if ($LASTEXITCODE -ne 0) {
  throw "Windows updater staging failed with exit code $LASTEXITCODE"
}

$canonicalSetup = "Codex.Taskboard_${version}_x64-setup.exe"
$expectedNames = @(
  $canonicalSetup,
  "$canonicalSetup.sig",
  "windows-updater.json"
) | Sort-Object
$actualNames = @(
  Get-ChildItem -LiteralPath $resolvedOutputDirectory -Force | ForEach-Object Name
) | Sort-Object
if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) {
  throw "Windows release staging contains an unexpected asset set"
}

& $authenticodeVerifier `
  -ExpectedSubject $ExpectedSubject `
  -ArtifactPath (Join-Path $resolvedOutputDirectory $canonicalSetup)
Write-Host "Verified Windows release staging for $ReleaseTag"
