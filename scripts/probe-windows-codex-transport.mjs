#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  codexAppEnvironment,
  codexAppExecutablePath,
  launchCodexAppWithPrivatePipe,
} from "../shared/codex-app-launch.mjs";
import {
  acquireCodexProfileLease,
  initializeIndependentCodexProfile,
} from "../shared/codex-profile.mjs";
import {
  CdpPipeBrowser,
  validatedLoopbackCdpWebSocketUrl,
} from "./codex-cdp-pipe.mjs";
import { isCodexTarget } from "./codex-target-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const markerId = "codex-taskboard-transport-probe-marker";

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} failed`);
  }
  return result.stdout.trim();
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fingerprintEntries(root, relative = "") {
  const directory = path.join(root, relative);
  const records = [];
  let fileCount = 0;
  for (const name of (await readdir(directory)).sort()) {
    const childRelative = path.join(relative, name);
    const childPath = path.join(root, childRelative);
    const details = await lstat(childPath, { bigint: true });
    if (details.isDirectory()) {
      records.push(`${childRelative.replaceAll(path.sep, "/")}\0directory`);
      const child = await fingerprintEntries(root, childRelative);
      records.push(...child.records);
      fileCount += child.fileCount;
    } else if (details.isSymbolicLink()) {
      const target = await readlink(childPath);
      records.push(`${childRelative.replaceAll(path.sep, "/")}\0symlink\0${target}`);
      fileCount += 1;
    } else if (details.isFile()) {
      records.push([
        childRelative.replaceAll(path.sep, "/"),
        "file",
        details.size.toString(),
        details.mtimeNs.toString(),
      ].join("\0"));
      fileCount += 1;
    }
  }
  return { records, fileCount };
}

export async function metadataFingerprint(root) {
  const resolved = path.resolve(root);
  const details = await lstat(resolved);
  assert.ok(details.isDirectory(), "Codex source profile must be a directory");
  const { records, fileCount } = await fingerprintEntries(resolved);
  return {
    sha256: createHash("sha256").update(records.join("\n")).digest("hex"),
    fileCount,
  };
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? 1);
  }
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      child.removeListener("exit", handleExit);
      reject(error);
    };
    const handleExit = (code) => {
      child.removeListener("error", handleError);
      resolve(code ?? 1);
    };
    child.once("error", handleError);
    child.once("exit", handleExit);
  });
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(Number.isInteger(port) && port > 0, "Could not reserve a loopback probe port");
  return port;
}

function launchPortProbe({ appPath, profilePath, port }) {
  return spawn(
    codexAppExecutablePath(appPath, { platform: "win32" }),
    [
      `--user-data-dir=${profilePath}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--no-default-browser-check",
    ],
    {
      env: codexAppEnvironment(profilePath),
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

async function dynamicPort(profilePath, child) {
  const activePortPath = path.join(profilePath, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Codex exited before assigning a dynamic CDP port");
    }
    try {
      const [port] = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && Number(port) > 0) return Number(port);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Codex DevToolsActivePort");
}

async function fetchCdpJson(port, endpoint, child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Codex exited before its CDP HTTP endpoint was ready");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return response.json();
      lastError = new Error(`CDP HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Codex CDP: ${lastError?.message ?? "unknown error"}`);
}

async function waitForPortTargets(port, child) {
  const deadline = Date.now() + 30_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    lastTargets = await fetchCdpJson(port, "/json/list", child);
    const codexTargets = lastTargets.filter(isCodexTarget);
    if (codexTargets.length >= 1) return { targets: lastTargets, codexTargets };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for an eligible Codex page target");
}

async function waitForPipeTargets(browser, child) {
  const deadline = Date.now() + 30_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Codex exited before exposing an eligible page target");
    }
    lastTargets = await browser.targets();
    const codexTargets = lastTargets.filter(isCodexTarget);
    if (codexTargets.length >= 1) return { targets: lastTargets, codexTargets };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for an eligible Codex page target");
}

async function evaluateWebSocket(url, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out evaluating the Codex CDP target"));
    }, 10_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(message.error?.message || "CDP evaluation failed"));
      } else {
        resolve(message.result?.result?.value);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Codex CDP WebSocket failed"));
    }, { once: true });
  });
}

function uniqueTargetTypes(targets) {
  return [...new Set(targets.map((target) => target.type).filter(Boolean))].sort();
}

async function profileProcessCount(profilePath) {
  const command = [
    "$needle = $env:CODEX_TASKBOARD_PROBE_PROFILE;",
    "$count = @(Get-CimInstance Win32_Process | Where-Object {",
    "$null -ne $_.CommandLine -and $_.CommandLine.IndexOf($needle,",
    "[StringComparison]::OrdinalIgnoreCase) -ge 0",
    "}).Count; Write-Output $count",
  ].join(" ");
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      CODEX_TASKBOARD_PROBE_PROFILE: profilePath,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Windows process residue probe failed");
  }
  const output = result.stdout.trim();
  assert.match(output, /^\d+$/, "Windows process residue probe returned invalid output");
  return Number(output);
}

async function runPortMode({ appPath, profilePath, dynamic }) {
  const requestedPort = dynamic ? 0 : await unusedLoopbackPort();
  const child = launchPortProbe({ appPath, profilePath, port: requestedPort });
  try {
    const port = dynamic ? await dynamicPort(profilePath, child) : requestedPort;
    await fetchCdpJson(port, "/json/version", child);
    const { targets, codexTargets } = await waitForPortTargets(port, child);
    const target = codexTargets[0];
    const debuggerUrl = validatedLoopbackCdpWebSocketUrl(target.webSocketDebuggerUrl, port);
    const noopExpressionValue = await evaluateWebSocket(debuggerUrl, "1 + 1");
    console.log(`Codex ${dynamic ? "port=0" : "fixed-port"} probe is ready; close that isolated Codex window normally.`);
    const exitCode = await waitForExit(child);
    return {
      ready: true,
      loopbackOnly: true,
      codexTargetCount: codexTargets.length,
      targetTypes: uniqueTargetTypes(targets),
      noopExpressionValue,
      controlledStop: exitCode === 0,
      residualProcessCount: await profileProcessCount(profilePath),
      ...(dynamic ? { dynamicPortAssigned: port > 0 } : { requestedPortHonored: true }),
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      console.error("Close the isolated Codex probe window to let cleanup finish safely.");
      await waitForExit(child);
    }
  }
}

async function runPipeMode({ appPath, profilePath }) {
  const child = launchCodexAppWithPrivatePipe({ appPath, profilePath, platform: "win32" });
  const browser = new CdpPipeBrowser(child);
  let markerSet = false;
  let markerRemoved = false;
  let markerPersistedAfterRemoval = true;
  try {
    await browser.open();
    const { targets, codexTargets } = await waitForPipeTargets(browser, child);
    const session = await browser.connect(codexTargets[0].targetId);
    try {
      const noop = await session.send("Runtime.evaluate", {
        expression: "1 + 1",
        returnByValue: true,
      });
      const setMarker = await session.send("Runtime.evaluate", {
        expression: `(() => {
          if (document.getElementById(${JSON.stringify(markerId)})) return false;
          const marker = document.createElement("meta");
          marker.id = ${JSON.stringify(markerId)};
          document.head.appendChild(marker);
          return true;
        })()`,
        returnByValue: true,
      });
      markerSet = setMarker.result?.value === true;
      const removeMarker = await session.send("Runtime.evaluate", {
        expression: `(() => {
          document.getElementById(${JSON.stringify(markerId)})?.remove();
          return !document.getElementById(${JSON.stringify(markerId)});
        })()`,
        returnByValue: true,
      });
      markerRemoved = removeMarker.result?.value === true;
      markerPersistedAfterRemoval = !markerRemoved;
      session.close();
      browser.close();
      console.log("Codex private-pipe probe is ready; close that isolated Codex window normally.");
      const exitCode = await waitForExit(child);
      return {
        ready: true,
        loopbackOnly: true,
        codexTargetCount: codexTargets.length,
        targetTypes: uniqueTargetTypes(targets),
        noopExpressionValue: noop.result?.value,
        controlledStop: exitCode === 0,
        residualProcessCount: await profileProcessCount(profilePath),
        markerSet,
        markerRemoved,
        markerPersistedAfterRemoval,
      };
    } finally {
      session.close();
    }
  } finally {
    browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      console.error("Close the isolated Codex probe window to let cleanup finish safely.");
      await waitForExit(child);
    }
  }
}

async function defaultProbeMode({ name, appPath, profilePath }) {
  if (name === "portZero") return runPortMode({ appPath, profilePath, dynamic: true });
  if (name === "fixedPort") return runPortMode({ appPath, profilePath, dynamic: false });
  if (name === "pipe") return runPipeMode({ appPath, profilePath });
  throw new Error(`Unknown Codex transport probe mode: ${name}`);
}

export async function runWindowsCodexTransportProbe({
  appPath,
  sourceProfilePath,
  outputPath,
  platform = process.platform,
  dependencies = {},
}) {
  assert.equal(platform, "win32", "Codex transport probe requires Windows");
  const fingerprint = dependencies.metadataFingerprint ?? metadataFingerprint;
  const initializeProfile = dependencies.initializeProfile ?? initializeIndependentCodexProfile;
  const acquireLease = dependencies.acquireLease ?? acquireCodexProfileLease;
  const probeMode = dependencies.probeMode ?? defaultProbeMode;
  const makeTemporaryRoot = dependencies.makeTemporaryRoot
    ?? (() => mkdtemp(path.join(os.tmpdir(), "codex-taskboard-windows-probe-")));
  const removePath = dependencies.removePath
    ?? ((targetPath) => rm(targetPath, { recursive: true, force: true }));
  const readPackage = dependencies.readPackage
    ?? (() => readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse));
  const resolveCommit = dependencies.resolveCommit
    ?? (() => commandOutput("git", ["rev-parse", "HEAD"]));
  const inspectExecutable = dependencies.inspectExecutable ?? lstat;

  const [packageJson, repoCommit, before] = await Promise.all([
    readPackage(),
    resolveCommit(),
    fingerprint(sourceProfilePath),
  ]);
  const executable = await inspectExecutable(
    codexAppExecutablePath(appPath, { platform: "win32" }),
  );
  assert.ok(executable.isFile(), "Codex Windows executable must be a file");
  assert.match(repoCommit, /^[0-9a-f]{40}$/, "Could not resolve the reviewed commit");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.ok(before.fileCount > 0, "Official Codex source profile is empty");

  const temporaryRoot = await makeTemporaryRoot();
  const modes = {};
  let initializedProfiles = 0;
  try {
    for (const name of ["portZero", "fixedPort", "pipe"]) {
      const profilePath = path.join(temporaryRoot, `${name}-${randomUUID()}`);
      await initializeProfile({
        sourceProfilePath,
        destinationProfilePath: profilePath,
      });
      initializedProfiles += 1;
      const lease = await acquireLease(profilePath);
      try {
        modes[name] = await probeMode({ name, appPath, profilePath });
      } finally {
        await lease.release();
      }
      await removePath(profilePath);
    }
  } finally {
    await removePath(temporaryRoot);
  }

  const after = await fingerprint(sourceProfilePath);
  const evidence = {
    schemaVersion: 1,
    kind: "transport-probe",
    capturedAt: new Date().toISOString(),
    repoCommit,
    appVersion: packageJson.version,
    sourceProfile: {
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
      fileCount: before.fileCount,
      modified: before.sha256 !== after.sha256 || before.fileCount !== after.fileCount,
    },
    isolatedProfile: {
      initialized: initializedProfiles === 3,
      destinationRemoved: !(await exists(temporaryRoot)),
    },
    credentialsIncluded: false,
    modes,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return evidence;
}

export async function main(argv = process.argv.slice(2)) {
  const [appPath, sourceProfilePath, evidenceDirectory] = argv;
  if (argv.length !== 3) {
    throw new Error(
      "Usage: probe-windows-codex-transport.mjs <ChatGPT.exe> <source-profile> <evidence-directory>",
    );
  }
  const outputPath = path.join(path.resolve(evidenceDirectory), "transport-probe.json");
  const evidence = await runWindowsCodexTransportProbe({
    appPath: path.resolve(appPath),
    sourceProfilePath: path.resolve(sourceProfilePath),
    outputPath,
  });
  console.log(`Captured sanitized Codex transport evidence: ${JSON.stringify({
    appVersion: evidence.appVersion,
    modes: Object.keys(evidence.modes),
  })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
