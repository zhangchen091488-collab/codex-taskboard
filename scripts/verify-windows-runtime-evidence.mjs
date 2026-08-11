#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WINDOWS_RUNTIME_EVIDENCE_FILES = Object.freeze([
  "environment.json",
  "transport-probe.json",
  "production-running.json",
  "production-normal-exit.json",
  "production-parent-exit.json",
  "production-forced-exit.json",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SAFE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const DISCOVERY_SOURCES = new Set([
  "ExplicitOverride",
  "StoredSelection",
  "SystemPackage",
  "UserSelection",
]);

function captured(value, label) {
  assert.equal(value?.schemaVersion, 1, `${label}: unsupported evidence schema`);
  assert.ok(Number.isFinite(Date.parse(value?.capturedAt)), `${label}: invalid capture time`);
  assert.match(value?.repoCommit ?? "", COMMIT, `${label}: invalid repository commit`);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /[A-Z]:\\\\Users\\\\|\/Users\//i, `${label}: user path leaked`);
  assert.doesNotMatch(
    serialized,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]+/i,
    `${label}: credential material leaked`,
  );
}

function validateEnvironment(value) {
  captured(value, "environment");
  assert.equal(value.kind, "environment");
  assert.match(value.snapshotLabel ?? "", SAFE_LABEL, "environment: invalid snapshot label");
  assert.match(value.os?.caption ?? "", /Windows 11/i, "environment: use Windows 11");
  assert.match(value.os?.architecture ?? "", /64/, "environment: use x64 Windows");
  assert.match(value.os?.buildNumber ?? "", /^\d+$/, "environment: invalid build number");
  assert.equal(value.account?.isAdministrator, false, "environment: use a standard user");
  assert.match(value.tools?.node ?? "", /^v22\./, "environment: Node 22 is required");
  assert.match(value.tools?.cargo ?? "", /^cargo 1\.88\./, "environment: Rust 1.88 is required");
  assert.match(value.tools?.git ?? "", /^git version \d+\./, "environment: Git is required");
  assert.equal(value.codexPackage?.name, "OpenAI.Codex");
  assert.equal(
    value.codexPackage?.publisher,
    "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
  );
  assert.equal(value.codexPackage?.familyName, "OpenAI.Codex_2p2nqsd0c76g0");
  assert.match(value.codexPackage?.version ?? "", /^\d+(?:\.\d+){3}$/);
  assert.equal(value.codexPackage?.executableExists, true);
  assert.equal(value.profiles?.sourceExists, true);
  assert.equal(value.profiles?.sourceAndIndependentOverlap, false);
  assert.equal(value.resetProcedureReviewed, true);
}

function validateTransportMode(mode, name) {
  assert.equal(mode?.ready, true, `${name}: transport was not ready`);
  assert.equal(mode?.loopbackOnly, true, `${name}: transport was not loopback-only`);
  assert.ok(Number.isSafeInteger(mode?.codexTargetCount) && mode.codexTargetCount >= 1);
  assert.deepEqual(
    [...(mode?.targetTypes ?? [])].sort(),
    [...new Set(mode?.targetTypes ?? [])].sort(),
    `${name}: duplicate target types`,
  );
  assert.ok(mode.targetTypes.includes("page"), `${name}: no Codex page target`);
  assert.equal(mode?.noopExpressionValue, 2, `${name}: no-op evaluation failed`);
  assert.equal(mode?.controlledStop, true, `${name}: probe was not stopped deliberately`);
  assert.equal(mode?.residualProcessCount, 0, `${name}: probe left processes behind`);
}

function validateTransport(value) {
  captured(value, "transport-probe");
  assert.equal(value.kind, "transport-probe");
  assert.match(value.appVersion ?? "", VERSION);
  assert.match(value.sourceProfile?.beforeSha256 ?? "", SHA256);
  assert.equal(value.sourceProfile.afterSha256, value.sourceProfile.beforeSha256);
  assert.ok(
    Number.isSafeInteger(value.sourceProfile?.fileCount) && value.sourceProfile.fileCount > 0,
    "transport-probe: source profile fingerprint is empty",
  );
  assert.equal(value.sourceProfile?.modified, false);
  assert.equal(value.isolatedProfile?.initialized, true);
  assert.equal(value.isolatedProfile?.destinationRemoved, true);
  assert.equal(value.credentialsIncluded, false);
  assert.deepEqual(Object.keys(value.modes ?? {}).sort(), ["fixedPort", "pipe", "portZero"]);
  validateTransportMode(value.modes.portZero, "portZero");
  validateTransportMode(value.modes.fixedPort, "fixedPort");
  validateTransportMode(value.modes.pipe, "pipe");
  assert.equal(value.modes.portZero.dynamicPortAssigned, true);
  assert.equal(value.modes.fixedPort.requestedPortHonored, true);
  assert.equal(value.modes.pipe.markerSet, true);
  assert.equal(value.modes.pipe.markerRemoved, true);
  assert.equal(value.modes.pipe.markerPersistedAfterRemoval, false);
}

function validateProduction(value) {
  captured(value, "production-running");
  assert.equal(value.kind, "production-running");
  assert.match(value.appVersion ?? "", VERSION);
  assert.ok(DISCOVERY_SOURCES.has(value.discovery?.source), "production: unknown discovery source");
  assert.equal(value.discovery?.executableExists, true);
  assert.equal(value.processes?.launcherCount, 1);
  assert.equal(value.processes?.injectorNodeCount, 1);
  assert.ok(value.processes?.isolatedCodexCount >= 1);
  assert.equal(value.arguments?.isolatedUserDataDir, true);
  assert.equal(value.arguments?.privateDebuggingPipe, true);
  assert.equal(value.arguments?.boundedLauncherLifecycle, true);
  assert.equal(value.readiness?.taskctlExitCode, 0);
  assert.equal(value.readiness?.randomLoopbackPort, true);
  assert.equal(value.readiness?.sidebarReady, true);
  assert.equal(value.logSignals?.discovery, true);
  assert.equal(value.logSignals?.jobObject, true);
  assert.equal(value.logSignals?.pipeReady, true);
  assert.equal(value.logSignals?.transportFailure, false);
  assert.equal(value.upstreamFilesModified, false);
  assert.equal(value.credentialsIncluded, false);
}

function validateCleanup(value, scenario) {
  captured(value, scenario);
  assert.equal(value.kind, "production-cleanup");
  assert.equal(value.scenario, scenario);
  assert.equal(value.childProcessesRemaining, 0, `${scenario}: child process residue`);
  assert.equal(value.taskboardNodeRemaining, 0, `${scenario}: Node residue`);
  assert.equal(value.isolatedCodexRemaining, 0, `${scenario}: Codex residue`);
  assert.equal(value.scenarioObserved, true, `${scenario}: scenario was not confirmed`);
  assert.equal(value.unrelatedProcessesTerminated, 0, `${scenario}: unrelated process was killed`);
  assert.equal(value.jobObjectKillOnClose, true, `${scenario}: Job Object policy missing`);
  assert.equal(value.pidReuseGuarded, true, `${scenario}: PID reuse guard missing`);
  assert.equal(value.handleLeakDetected, false, `${scenario}: handle leak detected`);
  assert.equal(value.credentialsIncluded, false);
  const expectedLauncherCount = scenario === "parent-exit" ? 0 : 1;
  assert.equal(value.launcherCount, expectedLauncherCount, `${scenario}: launcher count mismatch`);
}

export function validateWindowsRuntimeEvidence(evidence) {
  const environment = evidence.environment;
  const transport = evidence["transport-probe"];
  const production = evidence["production-running"];
  validateEnvironment(environment);
  validateTransport(transport);
  validateProduction(production);
  for (const scenario of ["normal-exit", "parent-exit", "forced-exit"]) {
    validateCleanup(evidence[`production-${scenario}`], scenario);
  }
  for (const value of Object.values(evidence)) {
    assert.equal(value.repoCommit, environment.repoCommit, "evidence commit mismatch");
  }
  assert.equal(transport.appVersion, production.appVersion, "probe/app version mismatch");
  return {
    repoCommit: environment.repoCommit,
    appVersion: production.appVersion,
    codexVersion: environment.codexPackage.version,
    discoverySource: production.discovery.source,
    transports: 3,
    cleanupScenarios: 3,
    decision: "go",
  };
}

export async function loadWindowsRuntimeEvidence(directory) {
  const evidence = {};
  for (const fileName of WINDOWS_RUNTIME_EVIDENCE_FILES) {
    const key = fileName.replace(/\.json$/, "");
    evidence[key] = JSON.parse(await readFile(path.join(directory, fileName), "utf8"));
  }
  return evidence;
}

export async function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 1, "Usage: verify-windows-runtime-evidence.mjs <evidence-directory>");
  const evidence = await loadWindowsRuntimeEvidence(path.resolve(argv[0]));
  console.log(`Verified Windows runtime evidence: ${JSON.stringify(
    validateWindowsRuntimeEvidence(evidence),
  )}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
