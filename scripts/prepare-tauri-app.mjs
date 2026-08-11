#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const nodeVersion = "22.23.2";
const nodeDistributionUrl = `https://nodejs.org/dist/v${nodeVersion}`;
const nodeArchitectures = ["arm64", "x64"];
const nodeArchiveSha256 = {
  arm64: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  x64: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
};
const windowsNodeArchiveName = `node-v${nodeVersion}-win-x64.zip`;
const windowsNodeArchiveSha256 =
  "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
const windowsNodeExecutableSha256 =
  "0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4";
const targetsByPlatform = new Map([
  ["darwin", new Set([
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "universal-apple-darwin",
  ])],
  ["win32", new Set(["x86_64-pc-windows-msvc"])],
]);
const defaultTargets = new Map([
  ["darwin", "universal-apple-darwin"],
  ["win32", "x86_64-pc-windows-msvc"],
]);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const binariesDirectory = path.join(tauriRoot, "binaries");
const resourcesDirectory = path.join(tauriRoot, "resources");
const runtimeCacheDirectory = path.join(projectRoot, "dist", "tauri-runtime-cache");
const extractionDirectory = path.join(runtimeCacheDirectory, "extracted");

function platformForTarget(target) {
  for (const [platform, targets] of targetsByPlatform) {
    if (targets.has(target)) return platform;
  }
  throw new Error(`Unsupported Tauri target: ${target}`);
}

export function parsePrepareArguments(argv, { hostPlatform = process.platform } = {}) {
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--target") throw new Error(`Unknown option: ${argument}`);
    if (target !== undefined) throw new Error("The --target option may only be specified once");
    target = argv[index + 1];
    if (!target || target.startsWith("--")) {
      throw new Error("The --target option requires a value");
    }
    index += 1;
  }

  if (target === undefined) {
    target = defaultTargets.get(hostPlatform);
    if (!target) {
      throw new Error(`Unsupported preparation platform: ${hostPlatform}`);
    }
  }

  return { platform: platformForTarget(target), target };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

export async function ensureVerifiedArchive({
  archivePath,
  expectedChecksum,
  url,
  fetchImpl = fetch,
}) {
  if ((await exists(archivePath)) && (await sha256(archivePath)) === expectedChecksum) {
    return { archivePath, fromCache: true };
  }

  const temporaryPath = `${archivePath}.${process.pid}-${randomUUID()}.download`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
    }
    await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
    const actualChecksum = await sha256(temporaryPath);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Checksum verification failed for ${path.basename(archivePath)}: ` +
          `expected ${expectedChecksum}, received ${actualChecksum}`,
      );
    }
    await rename(temporaryPath, archivePath);
    return { archivePath, fromCache: false };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function verifiedNodeArchive(architecture) {
  const archiveName = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`;
  const expectedChecksum = nodeArchiveSha256[architecture];
  const archivePath = path.join(runtimeCacheDirectory, archiveName);
  return ensureVerifiedArchive({
    archivePath,
    expectedChecksum,
    url: `${nodeDistributionUrl}/${archiveName}`,
  });
}

async function extractNodeRuntime(architecture) {
  const { archivePath } = await verifiedNodeArchive(architecture);
  const destination = path.join(extractionDirectory, architecture);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);
  return path.join(destination, `node-v${nodeVersion}-darwin-${architecture}`);
}

export function windowsZipExtractionCommand(
  archivePath,
  destination,
  { platform = process.platform, environment = process.env } = {},
) {
  if (platform === "win32") {
    const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || String.raw`C:\Windows`;
    return {
      command: path.win32.join(systemRoot, "System32", "tar.exe"),
      args: ["-xf", archivePath, "-C", destination],
    };
  }
  if (platform === "darwin") {
    return { command: "/usr/bin/ditto", args: ["-x", "-k", archivePath, destination] };
  }
  if (platform === "linux") {
    return { command: "unzip", args: ["-q", archivePath, "-d", destination] };
  }
  throw new Error(`ZIP extraction is not supported on platform: ${platform}`);
}

export function assertWindowsX64Pe(contents, fileName = "Windows Node executable") {
  if (
    !Buffer.isBuffer(contents) ||
    contents.length < 64 ||
    contents.toString("ascii", 0, 2) !== "MZ"
  ) {
    throw new Error(`${fileName} is not a valid PE executable`);
  }
  const peOffset = contents.readUInt32LE(0x3c);
  if (
    peOffset + 6 > contents.length ||
    contents.toString("binary", peOffset, peOffset + 4) !== "PE\u0000\u0000"
  ) {
    throw new Error(`${fileName} is not a valid PE executable`);
  }
  const machine = contents.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(
      `${fileName} has unsupported PE machine 0x${machine.toString(16)}; expected x86_64`,
    );
  }
}

async function verifiedWindowsNodeArchive() {
  const archivePath = path.join(runtimeCacheDirectory, windowsNodeArchiveName);
  return ensureVerifiedArchive({
    archivePath,
    expectedChecksum: windowsNodeArchiveSha256,
    url: `${nodeDistributionUrl}/${windowsNodeArchiveName}`,
  });
}

async function prepareWindowsNodeRuntime() {
  const { archivePath } = await verifiedWindowsNodeArchive();
  const destination = path.join(extractionDirectory, "win32-x64");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const extraction = windowsZipExtractionCommand(archivePath, destination);
  run(extraction.command, extraction.args);

  const runtimeRoot = path.join(destination, `node-v${nodeVersion}-win-x64`);
  const sourceNodePath = path.join(runtimeRoot, "node.exe");
  const temporaryNodePath = path.join(
    binariesDirectory,
    `.node-x86_64-pc-windows-msvc.exe.${process.pid}-${randomUUID()}.prepare`,
  );
  const targetNodePath = path.join(binariesDirectory, "node-x86_64-pc-windows-msvc.exe");
  await mkdir(binariesDirectory, { recursive: true });
  try {
    await copyFile(sourceNodePath, temporaryNodePath);
    const executableChecksum = await sha256(temporaryNodePath);
    if (executableChecksum !== windowsNodeExecutableSha256) {
      throw new Error(
        `Checksum verification failed for node.exe: expected ${windowsNodeExecutableSha256}, ` +
          `received ${executableChecksum}`,
      );
    }
    assertWindowsX64Pe(await readFile(temporaryNodePath), "node.exe");
    await rename(temporaryNodePath, targetNodePath);
  } finally {
    await rm(temporaryNodePath, { force: true });
  }

  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtimeRoot, "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function prepareNodeRuntime() {
  const runtimes = new Map();
  for (const architecture of nodeArchitectures) {
    runtimes.set(architecture, await extractNodeRuntime(architecture));
  }

  const universalNodePath = path.join(binariesDirectory, "node-universal-apple-darwin");
  await mkdir(binariesDirectory, { recursive: true });
  run("/usr/bin/lipo", [
    "-create",
    path.join(runtimes.get("arm64"), "bin", "node"),
    path.join(runtimes.get("x64"), "bin", "node"),
    "-output",
    universalNodePath,
  ]);
  await chmod(universalNodePath, 0o755);
  const architectures = run("/usr/bin/lipo", ["-archs", universalNodePath]);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error(`Universal Node runtime has unexpected architectures: ${architectures}`);
  }

  for (const targetTriple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const targetPath = path.join(binariesDirectory, `node-${targetTriple}`);
    await rm(targetPath, { force: true });
    await link(universalNodePath, targetPath);
  }
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtimes.get("arm64"), "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function copyApplicationResources() {
  const appResources = path.join(resourcesDirectory, "app");
  await rm(resourcesDirectory, { recursive: true, force: true });
  await mkdir(appResources, { recursive: true });
  await Promise.all([
    cp(path.join(projectRoot, "server"), path.join(appResources, "server"), { recursive: true }),
    cp(path.join(projectRoot, "shared"), path.join(appResources, "shared"), { recursive: true }),
    cp(path.join(projectRoot, "dist", "web"), path.join(appResources, "dist", "web"), {
      recursive: true,
    }),
    cp(
      path.join(projectRoot, "skills", "manage-taskboard"),
      path.join(appResources, "skills", "manage-taskboard"),
      { recursive: true },
    ),
  ]);

  await mkdir(path.join(appResources, "scripts"), { recursive: true });
  for (const fileName of [
    "codex-cdp-pipe.mjs",
    "codex-injector.mjs",
    "codex-injector-runtime.mjs",
    "codex-rate-limits.mjs",
    "taskboard-supervisor.mjs",
  ]) {
    await copyFile(
      path.join(projectRoot, "scripts", fileName),
      path.join(appResources, "scripts", fileName),
    );
  }
  await mkdir(path.join(appResources, "inject"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "inject", "codex-taskboard.user.js"),
    path.join(appResources, "inject", "codex-taskboard.user.js"),
  );
  await mkdir(path.join(appResources, "cli"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "cli", "taskctl.mjs"),
    path.join(appResources, "cli", "taskctl.mjs"),
  );
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(tauriRoot, "licenses", "Lobe-Icons-LICENSE.txt"),
    path.join(resourcesDirectory, "licenses", "Lobe-Icons-LICENSE.txt"),
  );
}

async function prepareMacosTaskctlWrapper() {
  const taskctlWrapper = `#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTENTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export CODEX_TASKBOARD_DATA_DIR="$HOME/Library/Application Support/Codex Taskboard"
export CODEX_TASKBOARD_RUNTIME_FILE="$CODEX_TASKBOARD_DATA_DIR/launcher-runtime.json"
exec "$CONTENTS_DIR/MacOS/node" "$CONTENTS_DIR/Resources/app/cli/taskctl.mjs" "$@"
`;
  const taskctlPath = path.join(resourcesDirectory, "bin", "taskctl");
  await mkdir(path.dirname(taskctlPath), { recursive: true });
  await writeFile(taskctlPath, taskctlWrapper);
  await chmod(taskctlPath, 0o755);
}

export function windowsTaskctlWrapper() {
  return [
    "@echo off",
    "setlocal",
    'for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"',
    'set "NODE_EXE=%APP_DIR%\\node.exe"',
    'set "TASKCTL_CLI=%APP_DIR%\\app\\cli\\taskctl.mjs"',
    'if not exist "%NODE_EXE%" (',
    '  >&2 echo Codex Taskboard Node sidecar was not found: "%NODE_EXE%"',
    "  exit /b 1",
    ")",
    'if not exist "%TASKCTL_CLI%" (',
    '  >&2 echo Codex Taskboard CLI was not found: "%TASKCTL_CLI%"',
    "  exit /b 1",
    ")",
    "if not defined CODEX_TASKBOARD_DATA_DIR (",
    "  if not defined APPDATA (",
    "    >&2 echo APPDATA is required to locate Codex Taskboard data",
    "    exit /b 1",
    "  )",
    '  set "CODEX_TASKBOARD_DATA_DIR=%APPDATA%\\com.chuspeeism.codex-taskboard"',
    ")",
    "if not defined CODEX_TASKBOARD_RUNTIME_FILE (",
    '  set "CODEX_TASKBOARD_RUNTIME_FILE=%CODEX_TASKBOARD_DATA_DIR%\\launcher-runtime.json"',
    ")",
    '"%NODE_EXE%" "%TASKCTL_CLI%" %*',
    'set "TASKCTL_EXIT_CODE=%ERRORLEVEL%"',
    "endlocal & exit /b %TASKCTL_EXIT_CODE%",
    "",
  ].join("\r\n");
}

async function prepareWindowsTaskctlWrapper() {
  const taskctlPath = path.join(resourcesDirectory, "bin", "taskctl.cmd");
  await mkdir(path.dirname(taskctlPath), { recursive: true });
  await writeFile(taskctlPath, windowsTaskctlWrapper(), "utf8");
}

async function prepareMacos(target) {
  if (process.platform !== "darwin") {
    throw new Error("Codex Taskboard for macOS must be prepared on macOS");
  }
  await mkdir(runtimeCacheDirectory, { recursive: true });
  await copyApplicationResources();
  await prepareMacosTaskctlWrapper();
  try {
    await prepareNodeRuntime();
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
  console.log(`Prepared Tauri resources for ${target} with Node.js ${nodeVersion}`);
}

async function prepareWindows(target) {
  await mkdir(runtimeCacheDirectory, { recursive: true });
  await copyApplicationResources();
  await prepareWindowsTaskctlWrapper();
  try {
    await prepareWindowsNodeRuntime();
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
  console.log(`Prepared Tauri resources for ${target} with Node.js ${nodeVersion}`);
}

export async function dispatchPreparation(
  request,
  handlers = { darwin: prepareMacos, win32: prepareWindows },
) {
  const handler = handlers[request.platform];
  if (typeof handler !== "function") {
    throw new Error(`Unsupported preparation platform: ${request.platform}`);
  }
  return handler(request.target);
}

export async function main(argv = process.argv.slice(2)) {
  return dispatchPreparation(parsePrepareArguments(argv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
