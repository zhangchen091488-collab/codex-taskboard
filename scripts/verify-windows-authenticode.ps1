param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSubject,

  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$ArtifactPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($ArtifactPath.Count -eq 0) {
  throw "At least one Authenticode artifact is required"
}

foreach ($path in $ArtifactPath) {
  $resolvedPath = (Resolve-Path -LiteralPath $path).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode signature is not valid: $resolvedPath ($($signature.Status))"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Authenticode signer certificate is missing: $resolvedPath"
  }
  if ($signature.SignerCertificate.Subject -ne $ExpectedSubject) {
    throw "Authenticode signer subject mismatch: $resolvedPath"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Authenticode timestamp is missing: $resolvedPath"
  }
  Write-Host "Verified Authenticode signature and timestamp: $resolvedPath"
}
