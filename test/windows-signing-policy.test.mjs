import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createWindowsSigningConfiguration,
  signingConfigurationFromEnvironment,
} from "../scripts/windows-signing-policy.mjs";

const importScript = await readFile(
  new URL("../scripts/import-windows-signing-certificate.ps1", import.meta.url),
  "utf8",
);
const verifyScript = await readFile(
  new URL("../scripts/verify-windows-authenticode.ps1", import.meta.url),
  "utf8",
);
const removeScript = await readFile(
  new URL("../scripts/remove-windows-signing-certificate.ps1", import.meta.url),
  "utf8",
);
const windowsConfig = await readFile(
  new URL("../src-tauri/tauri.windows.conf.json", import.meta.url),
  "utf8",
);

test("Windows signing config contains only reviewed public signing metadata", () => {
  assert.deepEqual(
    createWindowsSigningConfiguration({
      certificateThumbprint: "aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd",
      timestampUrl: "https://timestamp.example.test/rfc3161",
      timestampProtocol: "rfc3161",
    }),
    {
      bundle: {
        windows: {
          certificateThumbprint: "AABBCCDDEEFF00112233445566778899AABBCCDD",
          digestAlgorithm: "sha256",
          timestampUrl: "https://timestamp.example.test/rfc3161",
          tsp: true,
        },
      },
    },
  );
  assert.equal(
    signingConfigurationFromEnvironment({
      WINDOWS_CERTIFICATE_THUMBPRINT: "0123456789abcdef0123456789abcdef01234567",
      WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test/authenticode",
      WINDOWS_TIMESTAMP_PROTOCOL: "authenticode",
    }).bundle.windows.tsp,
    false,
  );
});

test("Windows signing config fails closed on thumbprint, transport, and protocol", () => {
  assert.throws(
    () => createWindowsSigningConfiguration({
      certificateThumbprint: "test-certificate",
      timestampUrl: "https://timestamp.example.test",
      timestampProtocol: "rfc3161",
    }),
    /40-character SHA-1/,
  );
  assert.throws(
    () => createWindowsSigningConfiguration({
      certificateThumbprint: "A".repeat(40),
      timestampUrl: "http://timestamp.example.test",
      timestampProtocol: "rfc3161",
    }),
    /must use HTTPS/,
  );
  assert.throws(
    () => createWindowsSigningConfiguration({
      certificateThumbprint: "A".repeat(40),
      timestampUrl: "https://timestamp.example.test",
      timestampProtocol: "unknown",
    }),
    /authenticode or rfc3161/,
  );
});

test("protected import and verification scripts enforce signer identity and timestamp", () => {
  assert.match(importScript, /Cert:\\CurrentUser\\My/);
  assert.match(importScript, /-Exportable:\$false/);
  assert.match(importScript, /WINDOWS_CERTIFICATE_SUBJECT/);
  assert.match(importScript, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(importScript, /privateKeyCertificates\.Count -ne 1/);
  assert.match(importScript, /foreach \(\$importedCertificate in \$importedCertificates\)/);
  assert.match(importScript, /finally/);
  assert.match(importScript, /NotBefore\.ToUniversalTime/);
  assert.match(importScript, /NotAfter\.ToUniversalTime/);
  assert.doesNotMatch(importScript, /Write-(?:Host|Output).*WINDOWS_CERTIFICATE/);

  assert.match(verifyScript, /Get-AuthenticodeSignature/);
  assert.match(verifyScript, /SignatureStatus\]::Valid/);
  assert.match(verifyScript, /SignerCertificate\.Subject -ne \$ExpectedSubject/);
  assert.match(verifyScript, /TimeStamperCertificate/);
  assert.match(removeScript, /\^\[A-F0-9\]\{40\}\$/);
  assert.match(removeScript, /Cert:\\CurrentUser\\My\\\$thumbprint/);
  assert.doesNotMatch(removeScript, /Remove-Item[^\n]*Cert:\\CurrentUser\\My["']?\s+-Recurse/);
  assert.doesNotMatch(windowsConfig, /certificateThumbprint|timestampUrl|signCommand/);
});
