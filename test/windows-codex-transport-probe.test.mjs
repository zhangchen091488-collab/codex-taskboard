import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  metadataFingerprint,
  runWindowsCodexTransportProbe,
} from "../scripts/probe-windows-codex-transport.mjs";

const commit = "a".repeat(40);
const digest = "b".repeat(64);

function modeEvidence(extra = {}) {
  return {
    ready: true,
    loopbackOnly: true,
    codexTargetCount: 1,
    targetTypes: ["page"],
    noopExpressionValue: 2,
    controlledStop: true,
    residualProcessCount: 0,
    ...extra,
  };
}

function probeModeEvidence(name) {
  if (name === "portZero") return modeEvidence({ dynamicPortAssigned: true });
  if (name === "fixedPort") return modeEvidence({ requestedPortHonored: true });
  return modeEvidence({
    markerSet: true,
    markerRemoved: true,
    markerPersistedAfterRemoval: false,
  });
}

function dependencies(temporaryRoot, observations, overrides = {}) {
  let fingerprintCalls = 0;
  return {
    metadataFingerprint: async () => {
      fingerprintCalls += 1;
      observations.fingerprintCalls = fingerprintCalls;
      return { sha256: digest, fileCount: 5 };
    },
    initializeProfile: async ({ destinationProfilePath }) => {
      observations.initialized.push(destinationProfilePath);
      await mkdir(destinationProfilePath, { recursive: true });
    },
    acquireLease: async (profilePath) => {
      observations.leased.push(profilePath);
      return { release: async () => observations.released.push(profilePath) };
    },
    probeMode: async ({ name, profilePath }) => {
      observations.probed.push({ name, profilePath });
      return probeModeEvidence(name);
    },
    makeTemporaryRoot: async () => temporaryRoot,
    readPackage: async () => ({ version: "0.2.2" }),
    resolveCommit: async () => commit,
    inspectExecutable: async () => ({ isFile: () => true }),
    ...overrides,
  };
}

function observations() {
  return {
    initialized: [],
    leased: [],
    released: [],
    probed: [],
    fingerprintCalls: 0,
  };
}

test("metadata fingerprint is stable and detects source profile metadata changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-profile-fingerprint-"));
  try {
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "settings.json"), "{}\n");
    await writeFile(path.join(directory, "nested", "state"), "ready\n");

    const first = await metadataFingerprint(directory);
    const second = await metadataFingerprint(directory);
    assert.deepEqual(second, first);
    assert.equal(first.fileCount, 2);

    await writeFile(path.join(directory, "settings.json"), "{\"changed\":true}\n");
    const changed = await metadataFingerprint(directory);
    assert.notEqual(changed.sha256, first.sha256);
    assert.equal(changed.fileCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows Codex transport probe uses three disposable profiles and sanitized evidence", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "windows-codex-probe-test-"));
  const temporaryRoot = path.join(workspace, "profiles");
  const outputPath = path.join(workspace, "evidence", "transport-probe.json");
  const seen = observations();
  await mkdir(temporaryRoot);
  try {
    const evidence = await runWindowsCodexTransportProbe({
      appPath: String.raw`C:\Program Files\WindowsApps\OpenAI.Codex\ChatGPT.exe`,
      sourceProfilePath: String.raw`C:\Users\Test\AppData\Roaming\Codex`,
      outputPath,
      platform: "win32",
      dependencies: dependencies(temporaryRoot, seen),
    });

    assert.deepEqual(seen.probed.map(({ name }) => name), ["portZero", "fixedPort", "pipe"]);
    assert.equal(new Set(seen.initialized).size, 3);
    assert.deepEqual(seen.leased, seen.initialized);
    assert.deepEqual(seen.released, seen.initialized);
    assert.equal(seen.fingerprintCalls, 2);
    assert.deepEqual(evidence.sourceProfile, {
      beforeSha256: digest,
      afterSha256: digest,
      fileCount: 5,
      modified: false,
    });
    assert.deepEqual(evidence.isolatedProfile, {
      initialized: true,
      destinationRemoved: true,
    });
    assert.equal(evidence.credentialsIncluded, false);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), evidence);
    await assert.rejects(readFile(temporaryRoot), /ENOENT/);

    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /Program Files|Users\\Test|AppData/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Windows Codex transport probe removes disposable profiles after a probe failure", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "windows-codex-probe-failure-"));
  const temporaryRoot = path.join(workspace, "profiles");
  const outputPath = path.join(workspace, "evidence", "transport-probe.json");
  const seen = observations();
  await mkdir(temporaryRoot);
  try {
    await assert.rejects(
      runWindowsCodexTransportProbe({
        appPath: "ChatGPT.exe",
        sourceProfilePath: "source-profile",
        outputPath,
        platform: "win32",
        dependencies: dependencies(temporaryRoot, seen, {
          probeMode: async () => {
            throw new Error("simulated transport failure");
          },
        }),
      }),
      /simulated transport failure/,
    );
    await assert.rejects(readFile(temporaryRoot), /ENOENT/);
    await assert.rejects(readFile(outputPath), /ENOENT/);
    assert.equal(seen.released.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Windows Codex transport probe rejects non-Windows execution", async () => {
  await assert.rejects(
    runWindowsCodexTransportProbe({
      appPath: "ChatGPT.exe",
      sourceProfilePath: "source-profile",
      outputPath: "transport-probe.json",
      platform: "darwin",
    }),
    /requires Windows/,
  );
});

test("transport probe is diagnostic-only and never runs the full injector or stops Codex", async () => {
  const source = await readFile(
    new URL("../scripts/probe-windows-codex-transport.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /--remote-debugging-port=\$\{port\}/);
  assert.match(source, /const requestedPort = dynamic \? 0/);
  assert.match(source, /launchCodexAppWithPrivatePipe/);
  assert.match(source, /Runtime\.evaluate/);
  assert.match(source, /codex-taskboard-transport-probe-marker/);
  assert.match(source, /\.remove\(\)/);
  assert.match(source, /await waitForExit\(child\)/);
  assert.match(source, /flag: "wx"/);
  assert.doesNotMatch(source, /codex-taskboard\.user\.js|injectAll/);
  assert.doesNotMatch(source, /taskkill|Stop-Process|TerminateProcess|child\.kill/i);
});
