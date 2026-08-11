$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$requiredNames = @(
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_CERTIFICATE_SUBJECT",
  "GITHUB_ENV",
  "RUNNER_TEMP"
)
foreach ($name in $requiredNames) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([String]::IsNullOrWhiteSpace($value)) {
    throw "Missing required protected signing variable: $name"
  }
}

$certificatePath = Join-Path $env:RUNNER_TEMP "codex-taskboard-signing.pfx"
$certificate = $null
$importedCertificates = @()
try {
  [IO.File]::WriteAllBytes(
    $certificatePath,
    [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE)
  )
  $password = ConvertTo-SecureString `
    -String $env:WINDOWS_CERTIFICATE_PASSWORD `
    -AsPlainText `
    -Force
  $importedCertificates = @(
    Import-PfxCertificate `
      -FilePath $certificatePath `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -Password $password `
      -Exportable:$false
  )
  $privateKeyCertificates = @(
    $importedCertificates | Where-Object { $_.HasPrivateKey }
  )
  if ($privateKeyCertificates.Count -ne 1) {
    throw "PFX must contain exactly one certificate with a private key"
  }
  $certificate = $privateKeyCertificates[0]

  if ($certificate.Subject -ne $env:WINDOWS_CERTIFICATE_SUBJECT) {
    throw "Imported certificate subject does not match WINDOWS_CERTIFICATE_SUBJECT"
  }
  if (-not $certificate.HasPrivateKey) {
    throw "Imported certificate does not expose a private key"
  }
  $codeSigningEku = $certificate.EnhancedKeyUsageList |
    Where-Object { $_.ObjectId.Value -eq "1.3.6.1.5.5.7.3.3" }
  if (-not $codeSigningEku) {
    throw "Imported certificate is not valid for code signing"
  }
  $now = [DateTime]::UtcNow
  if ($certificate.NotBefore.ToUniversalTime() -gt $now) {
    throw "Imported code-signing certificate is not valid yet"
  }
  if ($certificate.NotAfter.ToUniversalTime() -le $now) {
    throw "Imported code-signing certificate is expired"
  }

  "WINDOWS_CERTIFICATE_THUMBPRINT=$($certificate.Thumbprint)" |
    Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
} catch {
  foreach ($importedCertificate in $importedCertificates) {
    $importedPath = "Cert:\CurrentUser\My\$($importedCertificate.Thumbprint)"
    if (Test-Path -LiteralPath $importedPath) {
      Remove-Item -LiteralPath $importedPath -Force
    }
  }
  throw
} finally {
  if (Test-Path -LiteralPath $certificatePath) {
    Remove-Item -LiteralPath $certificatePath -Force
  }
}
