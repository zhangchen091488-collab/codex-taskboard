#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA1_THUMBPRINT = /^[A-F0-9]{40}$/;

export function createWindowsSigningConfiguration({
  certificateThumbprint,
  timestampUrl,
  timestampProtocol,
}) {
  const normalizedThumbprint = String(certificateThumbprint ?? "")
    .replace(/\s/g, "")
    .toUpperCase();
  assert.match(
    normalizedThumbprint,
    SHA1_THUMBPRINT,
    "WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint",
  );

  let parsedTimestampUrl;
  try {
    parsedTimestampUrl = new URL(timestampUrl);
  } catch {
    throw new Error("WINDOWS_TIMESTAMP_URL must be an absolute HTTPS URL");
  }
  assert.equal(
    parsedTimestampUrl.protocol,
    "https:",
    "WINDOWS_TIMESTAMP_URL must use HTTPS",
  );
  assert.ok(
    parsedTimestampUrl.hostname,
    "WINDOWS_TIMESTAMP_URL must include a hostname",
  );
  assert.ok(
    ["authenticode", "rfc3161"].includes(timestampProtocol),
    "WINDOWS_TIMESTAMP_PROTOCOL must be authenticode or rfc3161",
  );

  return {
    bundle: {
      windows: {
        certificateThumbprint: normalizedThumbprint,
        digestAlgorithm: "sha256",
        timestampUrl: parsedTimestampUrl.href,
        tsp: timestampProtocol === "rfc3161",
      },
    },
  };
}

export function signingConfigurationFromEnvironment(environment = process.env) {
  return createWindowsSigningConfiguration({
    certificateThumbprint: environment.WINDOWS_CERTIFICATE_THUMBPRINT,
    timestampUrl: environment.WINDOWS_TIMESTAMP_URL,
    timestampProtocol: environment.WINDOWS_TIMESTAMP_PROTOCOL,
  });
}

export function main() {
  console.log(JSON.stringify(signingConfigurationFromEnvironment()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
