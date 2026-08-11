$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$rawThumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT
if ([String]::IsNullOrWhiteSpace($rawThumbprint)) {
  throw "Missing WINDOWS_CERTIFICATE_THUMBPRINT"
}
$thumbprint = ($rawThumbprint -replace "\s", "").ToUpperInvariant()
if ($thumbprint -notmatch "^[A-F0-9]{40}$") {
  throw "WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint"
}

$certificatePath = "Cert:\CurrentUser\My\$thumbprint"
if (Test-Path -LiteralPath $certificatePath) {
  Remove-Item -LiteralPath $certificatePath -Force
}
