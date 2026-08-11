# Windows Authenticode signing policy

## Release boundary

Unsigned pull-request and CI builds must use `--no-sign`. A protected Windows
release imports a real code-signing PFX into `Cert:\CurrentUser\My`, validates
its exact subject, private key, code-signing EKU and expiry, then gives Tauri
only the certificate thumbprint and reviewed timestamp settings.

The repository must not contain a PFX, password, private key, production
thumbprint, placeholder test certificate or fixed certificate subject. The
protected release environment supplies:

- `WINDOWS_CERTIFICATE`: base64 PFX secret;
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX password secret;
- `WINDOWS_CERTIFICATE_SUBJECT`: exact approved publisher subject;
- `WINDOWS_TIMESTAMP_URL`: approved HTTPS timestamp service;
- `WINDOWS_TIMESTAMP_PROTOCOL`: `authenticode` or `rfc3161` as required by the
  certificate provider.

`scripts/import-windows-signing-certificate.ps1` writes the PFX only under the
ephemeral runner temp directory, imports it as non-exportable and deletes the
file in a `finally` block. It accepts exactly one imported certificate carrying
a private key. The release cleanup must run
`scripts/remove-windows-signing-certificate.ps1` in an `always()` step; that
script validates one exact thumbprint and never deletes a broad store path.

## Build and verification contract

`scripts/windows-signing-policy.mjs` emits the Tauri configuration override with
SHA-256 file digests and HTTPS timestamping. A release passes the emitted JSON
to `tauri build --config`; it never passes the PFX or password as an argument.

After bundling, `scripts/verify-windows-authenticode.ps1` must verify both the
Taskboard application executable and NSIS setup executable. Each must report:

- `Get-AuthenticodeSignature.Status` is `Valid`;
- signer subject exactly equals the protected expected subject;
- a timestamp certificate is present.

The bundled upstream Node executable is verified separately against its vendor
signature and checksum; it must not be re-signed as Taskboard code.

For the tamper test, copy a signed setup executable, change one byte in the
copy, and require the verification script to fail. Never modify the release
candidate in place. Preserve the original signature results and tamper failure
log with the release evidence.

The real certificate subject, timestamp service and signing result remain a
release-environment decision. Code readiness does not make WIN-062 complete
without those external values and Windows verification.
