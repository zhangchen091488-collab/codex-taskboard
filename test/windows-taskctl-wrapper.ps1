param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path $ProjectRoot).Path
$sourceWrapper = Join-Path $resolvedRoot "src-tauri\resources\bin\taskctl.cmd"
$sourceNode = Join-Path $resolvedRoot "src-tauri\binaries\node-x86_64-pc-windows-msvc.exe"
if (-not (Test-Path -PathType Leaf $sourceWrapper)) {
  throw "Prepared Windows taskctl wrapper was not found: $sourceWrapper"
}
if (-not (Test-Path -PathType Leaf $sourceNode)) {
  throw "Prepared Windows Node sidecar was not found: $sourceNode"
}

$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $temporaryRoot "任务面板 install with spaces-$([guid]::NewGuid())"
$fixtureBin = Join-Path $fixtureRoot "bin"
$fixtureCli = Join-Path $fixtureRoot "app\cli"
$fixtureNode = Join-Path $fixtureRoot "node.exe"
$fixtureWrapper = Join-Path $fixtureBin "taskctl.cmd"
$fixtureScript = Join-Path $fixtureCli "taskctl.mjs"
$fixtureAppData = Join-Path $fixtureRoot "用户 Data with spaces"

$savedPath = $env:PATH
$savedAppData = $env:APPDATA
$savedDataDirectory = $env:CODEX_TASKBOARD_DATA_DIR
$savedRuntimeFile = $env:CODEX_TASKBOARD_RUNTIME_FILE
$nativePreference = Get-Variable `
  -Name PSNativeCommandUseErrorActionPreference `
  -ErrorAction SilentlyContinue
$savedNativePreference = if ($null -ne $nativePreference) {
  $nativePreference.Value
} else {
  $null
}
try {
  New-Item -ItemType Directory -Force $fixtureBin, $fixtureCli | Out-Null
  Copy-Item $sourceNode $fixtureNode
  Copy-Item $sourceWrapper $fixtureWrapper
  @'
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  execPath: process.execPath,
  dataDirectory: process.env.CODEX_TASKBOARD_DATA_DIR,
  runtimeFile: process.env.CODEX_TASKBOARD_RUNTIME_FILE,
}));
process.exit(Number(process.argv[2]));
'@ | Set-Content -Encoding utf8 $fixtureScript

  $env:PATH = Join-Path $env:SystemRoot "System32"
  $env:APPDATA = $fixtureAppData
  $env:CODEX_TASKBOARD_DATA_DIR = $null
  $env:CODEX_TASKBOARD_RUNTIME_FILE = $null
  if ($null -ne $nativePreference) {
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $rawOutput = & $fixtureWrapper "37" "argument with spaces" "中文参数"
  $wrapperExitCode = $LASTEXITCODE
  $result = $rawOutput | ConvertFrom-Json

  if ($wrapperExitCode -ne 37) {
    throw "taskctl.cmd did not preserve exit code 37: $wrapperExitCode"
  }
  if ($result.argv.Count -ne 3 -or
      $result.argv[0] -ne "37" -or
      $result.argv[1] -ne "argument with spaces" -or
      $result.argv[2] -ne "中文参数") {
    throw "taskctl.cmd did not preserve its arguments: $($result.argv | ConvertTo-Json -Compress)"
  }
  if (-not [string]::Equals(
    [IO.Path]::GetFullPath($result.execPath),
    [IO.Path]::GetFullPath($fixtureNode),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "taskctl.cmd did not use the packaged Node sidecar: $($result.execPath)"
  }
  $expectedDataDirectory = Join-Path $fixtureAppData "com.chuspeeism.codex-taskboard"
  $expectedRuntimeFile = Join-Path $expectedDataDirectory "launcher-runtime.json"
  if ($result.dataDirectory -ne $expectedDataDirectory) {
    throw "taskctl.cmd selected an unexpected data directory: $($result.dataDirectory)"
  }
  if ($result.runtimeFile -ne $expectedRuntimeFile) {
    throw "taskctl.cmd selected an unexpected runtime descriptor: $($result.runtimeFile)"
  }
} finally {
  $env:PATH = $savedPath
  $env:APPDATA = $savedAppData
  $env:CODEX_TASKBOARD_DATA_DIR = $savedDataDirectory
  $env:CODEX_TASKBOARD_RUNTIME_FILE = $savedRuntimeFile
  if ($null -ne $nativePreference) {
    $PSNativeCommandUseErrorActionPreference = $savedNativePreference
  }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $fixtureRoot
}

Write-Output "Verified Windows taskctl wrapper path, environment, arguments, and exit code"
