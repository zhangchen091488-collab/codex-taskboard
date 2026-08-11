param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSubject,

  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedArtifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$runnerTemp = $env:RUNNER_TEMP
if ([String]::IsNullOrWhiteSpace($runnerTemp)) {
  throw "RUNNER_TEMP is required for the isolated tamper copy"
}
$tamperedPath = Join-Path `
  $runnerTemp `
  "authenticode-tamper-$([Guid]::NewGuid().ToString('N')).exe"
$verifier = Join-Path $PSScriptRoot "verify-windows-authenticode.ps1"

try {
  $bytes = [IO.File]::ReadAllBytes($resolvedArtifact)
  if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "Authenticode tamper candidate is not a PE executable"
  }
  $bytes[2] = $bytes[2] -bxor 0xff
  [IO.File]::WriteAllBytes($tamperedPath, $bytes)

  $verificationSucceeded = $false
  $failureMessage = $null
  try {
    & $verifier -ExpectedSubject $ExpectedSubject -ArtifactPath $tamperedPath
    $verificationSucceeded = $true
  } catch {
    $failureMessage = $_.Exception.Message
  }
  if ($verificationSucceeded) {
    throw "Authenticode verification unexpectedly accepted the tampered artifact"
  }
  if ([String]::IsNullOrWhiteSpace($failureMessage)) {
    throw "Authenticode verification failed without a reviewable error"
  }
  Write-Host "Verified Authenticode tamper rejection: $failureMessage"
} finally {
  if (Test-Path -LiteralPath $tamperedPath) {
    Remove-Item -LiteralPath $tamperedPath -Force
  }
}
