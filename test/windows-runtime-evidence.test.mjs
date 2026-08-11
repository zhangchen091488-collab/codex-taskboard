import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  loadWindowsRuntimeEvidence,
  validateWindowsRuntimeEvidence,
  WINDOWS_RUNTIME_EVIDENCE_FILES,
} from "../scripts/verify-windows-runtime-evidence.mjs";

const commit = "a".repeat(40);
const digest = "b".repeat(64);
const capturedAt = "2026-08-12T00:00:00.000Z";

function base(kind) {
  return { schemaVersion: 1, kind, capturedAt, repoCommit: commit };
}

function transportMode(extra = {}) {
  return {
    ready: true,
    loopbackOnly: true,
    codexTargetCount: 1,
    targetTypes: ["page", "worker"],
    noopExpressionValue: 2,
    controlledStop: true,
    residualProcessCount: 0,
    ...extra,
  };
}

function cleanup(scenario, launcherCount) {
  return {
    ...base("production-cleanup"),
    scenario,
    childProcessesRemaining: 0,
    taskboardNodeRemaining: 0,
    isolatedCodexRemaining: 0,
    launcherCount,
    unrelatedProcessesTerminated: 0,
    jobObjectKillOnClose: true,
    pidReuseGuarded: true,
    handleLeakDetected: false,
    credentialsIncluded: false,
  };
}

function validEvidence() {
  return {
    environment: {
      ...base("environment"),
      snapshotLabel: "win11-clean-01",
      os: {
        caption: "Microsoft Windows 11 Pro",
        architecture: "64-bit",
        buildNumber: "26100",
      },
      account: { isAdministrator: false },
      tools: {
        node: "v22.23.2",
        cargo: "cargo 1.88.0 (test)",
        git: "git version 2.50.1.windows.1",
      },
      codexPackage: {
        name: "OpenAI.Codex",
        publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
        familyName: "OpenAI.Codex_2p2nqsd0c76g0",
        version: "26.100.200.300",
        executableExists: true,
      },
      profiles: { sourceExists: true, sourceAndIndependentOverlap: false },
      resetProcedureReviewed: true,
    },
    "transport-probe": {
      ...base("transport-probe"),
      appVersion: "0.2.2",
      sourceProfile: { beforeSha256: digest, afterSha256: digest, modified: false },
      isolatedProfile: { initialized: true, destinationRemoved: true },
      credentialsIncluded: false,
      modes: {
        portZero: transportMode({ dynamicPortAssigned: true }),
        fixedPort: transportMode({ requestedPortHonored: true }),
        pipe: transportMode({
          markerSet: true,
          markerRemoved: true,
          markerPersistedAfterRemoval: false,
        }),
      },
    },
    "production-running": {
      ...base("production-running"),
      appVersion: "0.2.2",
      discovery: { source: "SystemPackage", executableExists: true },
      processes: { launcherCount: 1, injectorNodeCount: 1, isolatedCodexCount: 4 },
      arguments: {
        isolatedUserDataDir: true,
        privateDebuggingPipe: true,
        boundedLauncherLifecycle: true,
      },
      readiness: { taskctlExitCode: 0, randomLoopbackPort: true, sidebarReady: true },
      logSignals: {
        discovery: true,
        jobObject: true,
        pipeReady: true,
        injectionReady: true,
        transportFailure: false,
      },
      upstreamFilesModified: false,
      credentialsIncluded: false,
    },
    "production-normal-exit": cleanup("normal-exit", 1),
    "production-parent-exit": cleanup("parent-exit", 0),
    "production-forced-exit": cleanup("forced-exit", 1),
  };
}

test("Windows runtime evidence proves environment, transports, injection and cleanup", () => {
  assert.deepEqual(validateWindowsRuntimeEvidence(validEvidence()), {
    repoCommit: commit,
    appVersion: "0.2.2",
    codexVersion: "26.100.200.300",
    discoverySource: "SystemPackage",
    transports: 3,
    cleanupScenarios: 3,
    decision: "go",
  });
});

test("Windows runtime evidence loader requires every create-only evidence file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "windows-runtime-evidence-"));
  try {
    const evidence = validEvidence();
    await Promise.all(WINDOWS_RUNTIME_EVIDENCE_FILES.map((fileName) => {
      const key = fileName.replace(/\.json$/, "");
      return writeFile(path.join(directory, fileName), JSON.stringify(evidence[key]));
    }));
    assert.equal(
      validateWindowsRuntimeEvidence(await loadWindowsRuntimeEvidence(directory)).decision,
      "go",
    );
    await rm(path.join(directory, "transport-probe.json"));
    await assert.rejects(loadWindowsRuntimeEvidence(directory), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime verifier rejects privilege, profile mutation and missing CDP capabilities", () => {
  const elevated = validEvidence();
  elevated.environment.account.isAdministrator = true;
  assert.throws(() => validateWindowsRuntimeEvidence(elevated), /standard user/);

  const profileMutation = validEvidence();
  profileMutation["transport-probe"].sourceProfile.afterSha256 = "c".repeat(64);
  assert.throws(() => validateWindowsRuntimeEvidence(profileMutation));

  const missingPipe = validEvidence();
  missingPipe["transport-probe"].modes.pipe.ready = false;
  assert.throws(() => validateWindowsRuntimeEvidence(missingPipe), /pipe: transport was not ready/);

  const noInjection = validEvidence();
  noInjection["production-running"].readiness.sidebarReady = false;
  assert.throws(() => validateWindowsRuntimeEvidence(noInjection));
});

test("runtime verifier rejects process residue, unrelated kills and evidence path leaks", () => {
  const residue = validEvidence();
  residue["production-parent-exit"].isolatedCodexRemaining = 1;
  assert.throws(() => validateWindowsRuntimeEvidence(residue), /Codex residue/);

  const collateral = validEvidence();
  collateral["production-forced-exit"].unrelatedProcessesTerminated = 1;
  assert.throws(() => validateWindowsRuntimeEvidence(collateral), /unrelated process was killed/);

  const pathLeak = validEvidence();
  pathLeak.environment.notes = String.raw`C:\Users\Alice\AppData\Roaming`;
  assert.throws(() => validateWindowsRuntimeEvidence(pathLeak), /user path leaked/);
});

test("runtime verifier rejects mixed commits and versions", () => {
  const mixedCommit = validEvidence();
  mixedCommit["production-normal-exit"].repoCommit = "d".repeat(40);
  assert.throws(() => validateWindowsRuntimeEvidence(mixedCommit), /commit mismatch/);

  const mixedVersion = validEvidence();
  mixedVersion["transport-probe"].appVersion = "0.2.1";
  assert.throws(() => validateWindowsRuntimeEvidence(mixedVersion), /version mismatch/);
});
