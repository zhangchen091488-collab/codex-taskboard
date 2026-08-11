import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  WINDOWS_VM_SCENARIOS,
  loadWindowsVmMatrix,
  validateWindowsVmMatrix,
} from "../scripts/verify-windows-vm-matrix.mjs";

const hash = "a".repeat(64);
const signer = "CN=Taskboard Release Test";

function capture(scenario, expectedVersion, artifactVersion) {
  const installed = !["clean", "uninstalled"].includes(scenario);
  return {
    schemaVersion: 1,
    scenario,
    capturedAt: "2026-08-12T00:00:00.000Z",
    expectedVersion: installed ? expectedVersion : null,
    os: {
      caption: "Microsoft Windows 11 Pro",
      version: "10.0.26100",
      buildNumber: "26100",
      architecture: "64-bit",
    },
    artifact: installed
      ? {
          fileName: `Codex Taskboard_${artifactVersion}_x64-setup.exe`,
          artifactVersion,
          length: 1024,
          sha256: hash,
          signatureStatus: "Valid",
          signerSubject: signer,
          expectedSubject: signer,
          timestampPresent: true,
          timestampSubject: "CN=Timestamp Test",
        }
      : null,
    installationEntries: installed
      ? [{
          hive: "HKCU",
          key: "com.chuspeeism.codex-taskboard",
          displayName: "Codex Taskboard",
          displayVersion: expectedVersion,
          uninstallString: '"uninstall.exe"',
        }]
      : [],
    data: {
      directoryExists: scenario !== "clean",
      sentinel: scenario === "clean" ? { exists: false } : { exists: true, sha256: hash },
      updateStateExists: false,
      launcherLog: { exists: scenario !== "clean" },
    },
    managedProcesses: [],
  };
}

function validMatrix() {
  return {
    clean: capture("clean"),
    "installed-n": capture("installed-n", "1.0.0", "1.0.0"),
    "upgraded-n-plus-one": capture("upgraded-n-plus-one", "1.1.0", "1.1.0"),
    "same-version-reinstall": capture("same-version-reinstall", "1.1.0", "1.1.0"),
    "downgrade-attempt": capture("downgrade-attempt", "1.1.0", "1.0.0"),
    uninstalled: capture("uninstalled"),
    "reinstalled-n-plus-one": capture("reinstalled-n-plus-one", "1.1.0", "1.1.0"),
  };
}

test("Windows VM matrix proves upgrade, downgrade rejection, uninstall retention and reinstall", () => {
  assert.deepEqual(validateWindowsVmMatrix(validMatrix()), {
    baselineVersion: "1.0.0",
    candidateVersion: "1.1.0",
    signerSubject: signer,
    sentinelSha256: hash,
    scenarios: WINDOWS_VM_SCENARIOS.length,
  });
});

test("matrix loader consumes all seven create-only evidence files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "taskboard-windows-vm-"));
  try {
    const matrix = validMatrix();
    await Promise.all(WINDOWS_VM_SCENARIOS.map((scenario) =>
      writeFile(path.join(directory, `${scenario}.json`), JSON.stringify(matrix[scenario])),
    ));
    assert.equal(validateWindowsVmMatrix(await loadWindowsVmMatrix(directory)).scenarios, 7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("matrix rejects machine-wide install, version rollback and missing stages", () => {
  const machineWide = validMatrix();
  machineWide["installed-n"].installationEntries[0].hive = "HKLM";
  assert.throws(() => validateWindowsVmMatrix(machineWide), /current-user/);

  const rollback = validMatrix();
  rollback["downgrade-attempt"].expectedVersion = "1.0.0";
  rollback["downgrade-attempt"].installationEntries[0].displayVersion = "1.0.0";
  assert.throws(() => validateWindowsVmMatrix(rollback), /leave N\+1 installed/);

  const missing = validMatrix();
  delete missing.uninstalled;
  assert.throws(() => validateWindowsVmMatrix(missing), /missing Windows VM evidence/);
});

test("matrix rejects bad signatures, data loss, stale update state and process residue", () => {
  const unsigned = validMatrix();
  unsigned["upgraded-n-plus-one"].artifact.signatureStatus = "NotSigned";
  assert.throws(() => validateWindowsVmMatrix(unsigned), /Authenticode status/);

  const dataLoss = validMatrix();
  dataLoss.uninstalled.data.sentinel.exists = false;
  assert.throws(() => validateWindowsVmMatrix(dataLoss), /sentinel was removed/);

  const staleState = validMatrix();
  staleState["reinstalled-n-plus-one"].data.updateStateExists = true;
  assert.throws(() => validateWindowsVmMatrix(staleState), /windows-update-state\.json/);

  const residue = validMatrix();
  residue.uninstalled.managedProcesses.push({ name: "node.exe", processId: 1234 });
  assert.throws(() => validateWindowsVmMatrix(residue), /process tree must be stopped/);
});

test("PowerShell evidence capture remains read-only and create-only", async () => {
  const source = await readFile(
    new URL("../scripts/capture-windows-vm-evidence.ps1", import.meta.url),
    "utf8",
  );
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /HKEY_CURRENT_USER/);
  assert.match(source, /HKEY_LOCAL_MACHINE/);
  assert.match(source, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(source, /windows-update-state\.json/);
  assert.match(source, /FileMode\]::CreateNew/);
  assert.doesNotMatch(source, /Start-Process|Stop-Process|Remove-Item|Remove-ItemProperty/);
});
