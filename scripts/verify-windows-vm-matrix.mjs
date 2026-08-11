#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WINDOWS_VM_SCENARIOS = [
  "clean",
  "installed-n",
  "upgraded-n-plus-one",
  "same-version-reinstall",
  "downgrade-attempt",
  "uninstalled",
  "reinstalled-n-plus-one",
];

const INSTALLED_SCENARIOS = new Set(
  WINDOWS_VM_SCENARIOS.filter((scenario) => !["clean", "uninstalled"].includes(scenario)),
);
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function semverCore(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  assert.ok(match, `matrix version must use major.minor.patch: ${version}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = semverCore(left);
  const rightParts = semverCore(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function validateCapture(capture, scenario) {
  assert.equal(capture?.schemaVersion, 1, `${scenario}: unsupported evidence schema`);
  assert.equal(capture?.scenario, scenario, `${scenario}: scenario/file mismatch`);
  assert.ok(Number.isFinite(Date.parse(capture?.capturedAt)), `${scenario}: invalid capture time`);
  assert.match(capture?.os?.caption ?? "", /Windows 11/i, `${scenario}: use Windows 11`);
  assert.match(capture?.os?.architecture ?? "", /64/, `${scenario}: use x64 Windows`);
  assert.ok(Array.isArray(capture?.installationEntries), `${scenario}: missing registry evidence`);
  assert.ok(Array.isArray(capture?.managedProcesses), `${scenario}: missing process evidence`);
  assert.equal(
    capture.managedProcesses.length,
    0,
    `${scenario}: managed Taskboard process tree must be stopped before capture`,
  );
  assert.equal(
    capture?.data?.updateStateExists,
    false,
    `${scenario}: stable state must not retain windows-update-state.json`,
  );

  if (!INSTALLED_SCENARIOS.has(scenario)) {
    assert.equal(capture.expectedVersion, null, `${scenario}: expectedVersion must be null`);
    assert.equal(capture.artifact, null, `${scenario}: installer evidence must be null`);
    assert.equal(capture.installationEntries.length, 0, `${scenario}: app must not be installed`);
    return;
  }

  assert.match(capture.expectedVersion ?? "", SAFE_VERSION, `${scenario}: invalid expected version`);
  assert.equal(capture.installationEntries.length, 1, `${scenario}: require one install entry`);
  const entry = capture.installationEntries[0];
  assert.equal(entry.hive, "HKCU", `${scenario}: installer must remain current-user`);
  assert.equal(entry.displayName, "Codex Taskboard", `${scenario}: unexpected display name`);
  assert.equal(
    entry.displayVersion,
    capture.expectedVersion,
    `${scenario}: registry version mismatch`,
  );
  assert.match(entry.uninstallString ?? "", /\S/, `${scenario}: missing uninstaller registration`);

  const artifact = capture.artifact;
  assert.ok(artifact, `${scenario}: missing installer artifact evidence`);
  assert.match(artifact.artifactVersion ?? "", SAFE_VERSION, `${scenario}: invalid artifact version`);
  assert.ok(Number.isSafeInteger(artifact.length) && artifact.length > 0, `${scenario}: empty artifact`);
  assert.match(artifact.sha256 ?? "", SHA256, `${scenario}: invalid artifact SHA-256`);
  assert.equal(artifact.signatureStatus, "Valid", `${scenario}: invalid Authenticode status`);
  assert.match(artifact.expectedSubject ?? "", /\S/, `${scenario}: expected signer missing`);
  assert.equal(
    artifact.signerSubject,
    artifact.expectedSubject,
    `${scenario}: Authenticode signer mismatch`,
  );
  assert.equal(artifact.timestampPresent, true, `${scenario}: Authenticode timestamp missing`);
  assert.match(artifact.timestampSubject ?? "", /\S/, `${scenario}: timestamp signer missing`);
}

export function validateWindowsVmMatrix(captures) {
  for (const scenario of WINDOWS_VM_SCENARIOS) {
    assert.ok(captures?.[scenario], `missing Windows VM evidence: ${scenario}.json`);
    validateCapture(captures[scenario], scenario);
  }

  const installedN = captures["installed-n"];
  const upgraded = captures["upgraded-n-plus-one"];
  const repeated = captures["same-version-reinstall"];
  const downgrade = captures["downgrade-attempt"];
  const uninstalled = captures.uninstalled;
  const reinstalled = captures["reinstalled-n-plus-one"];
  const baselineVersion = installedN.expectedVersion;
  const candidateVersion = upgraded.expectedVersion;

  assert.ok(
    compareVersions(candidateVersion, baselineVersion) > 0,
    "N+1 must be newer than the installed N baseline",
  );
  assert.equal(installedN.artifact.artifactVersion, baselineVersion);
  assert.equal(upgraded.artifact.artifactVersion, candidateVersion);
  assert.equal(repeated.expectedVersion, candidateVersion);
  assert.equal(repeated.artifact.artifactVersion, candidateVersion);
  assert.equal(downgrade.expectedVersion, candidateVersion, "downgrade must leave N+1 installed");
  assert.equal(downgrade.artifact.artifactVersion, baselineVersion, "downgrade must use N artifact");
  assert.equal(reinstalled.expectedVersion, candidateVersion);
  assert.equal(reinstalled.artifact.artifactVersion, candidateVersion);

  const signedScenarios = [...INSTALLED_SCENARIOS];
  const expectedSubject = installedN.artifact.expectedSubject;
  for (const scenario of signedScenarios) {
    assert.equal(
      captures[scenario].artifact.expectedSubject,
      expectedSubject,
      `${scenario}: release signer changed within matrix`,
    );
  }

  assert.equal(installedN.data?.sentinel?.exists, true, "create sentinel before installed-n capture");
  assert.match(installedN.data.sentinel.sha256 ?? "", SHA256, "installed-n: invalid sentinel hash");
  const sentinelHash = installedN.data.sentinel.sha256;
  for (const scenario of [
    "upgraded-n-plus-one",
    "same-version-reinstall",
    "downgrade-attempt",
    "uninstalled",
    "reinstalled-n-plus-one",
  ]) {
    assert.equal(captures[scenario].data?.directoryExists, true, `${scenario}: app data was removed`);
    assert.equal(captures[scenario].data?.sentinel?.exists, true, `${scenario}: sentinel was removed`);
    assert.equal(
      captures[scenario].data.sentinel.sha256,
      sentinelHash,
      `${scenario}: sentinel content changed`,
    );
  }

  return {
    baselineVersion,
    candidateVersion,
    signerSubject: expectedSubject,
    sentinelSha256: sentinelHash,
    scenarios: WINDOWS_VM_SCENARIOS.length,
  };
}

export async function loadWindowsVmMatrix(evidenceDirectory) {
  const captures = {};
  for (const scenario of WINDOWS_VM_SCENARIOS) {
    const filePath = path.join(evidenceDirectory, `${scenario}.json`);
    captures[scenario] = JSON.parse(await readFile(filePath, "utf8"));
  }
  return captures;
}

export async function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 1, "Usage: verify-windows-vm-matrix.mjs <evidence-directory>");
  const evidenceDirectory = path.resolve(argv[0]);
  const summary = validateWindowsVmMatrix(await loadWindowsVmMatrix(evidenceDirectory));
  console.log(`Verified Windows VM matrix: ${JSON.stringify(summary)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
