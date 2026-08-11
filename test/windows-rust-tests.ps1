param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$manifestPath = Join-Path $root "src-tauri\Cargo.toml"
$cargoArguments = @(
  "test",
  "--locked",
  "--manifest-path",
  $manifestPath,
  "--target",
  "x86_64-pc-windows-msvc"
)
$nativePreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
$savedNativePreference = if ($null -ne $nativePreference) { $nativePreference.Value } else { $null }

function Write-GitHubError {
  param([Parameter(Mandatory = $true)][string]$Message)

  $escapedMessage = $Message.Replace("%", "%25").Replace("`r", "%0D").Replace("`n", "%0A")
  Write-Output "::error file=src-tauri/src/platform/windows.rs,title=Windows Rust tests failed::$escapedMessage"
}

try {
  if ($null -ne $nativePreference) {
    $PSNativeCommandUseErrorActionPreference = $false
  }

  & cargo @cargoArguments
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Windows Rust launcher lifecycle tests passed."
    return
  }

  Write-Warning "The full Windows Rust test suite failed. Re-running each test separately to identify the failure."

  $listedTests = @(& cargo @cargoArguments "--" "--list" "--format" "terse")
  if ($LASTEXITCODE -ne 0) {
    Write-GitHubError "The full Windows Rust suite failed and Cargo could not list the tests for diagnosis."
    exit 1
  }

  $testNames = @(
    $listedTests | ForEach-Object {
      if ($_ -match "^(?<name>.+): test$") {
        $Matches.name
      }
    }
  )

  if ($testNames.Count -eq 0) {
    Write-GitHubError "The full Windows Rust suite failed and no Rust tests were discovered for diagnosis."
    exit 1
  }

  $failingTests = @()
  foreach ($testName in $testNames) {
    Write-Host "Diagnosing Rust test: $testName"
    & cargo @cargoArguments "--" "--exact" $testName "--nocapture"
    if ($LASTEXITCODE -ne 0) {
      $failingTests += $testName
    }
  }

  if ($failingTests.Count -gt 0) {
    Write-GitHubError "Failing Windows Rust tests: $($failingTests -join ', ')"
  } else {
    Write-GitHubError "The full Windows Rust suite failed, but every test passed in isolation. Investigate shared state or test concurrency."
  }

  exit 1
} finally {
  if ($null -ne $nativePreference) {
    $PSNativeCommandUseErrorActionPreference = $savedNativePreference
  }
}
