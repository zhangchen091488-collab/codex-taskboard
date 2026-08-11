#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  WINDOWS_NODE_EXECUTABLE_SHA256,
  assertWindowsX64Pe,
  windowsTaskctlWrapper,
} from "./prepare-tauri-app.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const selectedScripts = [
  "codex-cdp-pipe.mjs",
  "codex-injector.mjs",
  "codex-injector-runtime.mjs",
  "codex-rate-limits.mjs",
  "taskboard-supervisor.mjs",
];
const forbiddenDirectoryNames = new Set([".data", ".git", "node_modules", "test", "tests"]);
const forbiddenFileNames = new Set([".DS_Store", "package-lock.json", "package.json"]);
const forbiddenFilePattern =
  /^(?:\.env|\.dev\.vars)|\.(?:key|log|map|p12|patch|pem|sqlite(?:-shm|-wal)?)$/i;
const defaultExpectations = Object.freeze({
  iconSha256: "92d997f926d83d15532e9f7c2100a0708f4f20a4553018e0414a2d766c127268",
  nodeExecutableSha256: WINDOWS_NODE_EXECUTABLE_SHA256,
  nodeLicenseSha256: "8cc9bb466b19fc7e7cc99d03e9df1132021fda8b01eea2624c58bb372dbef576",
});

function failure(category, message) {
  return new Error(`[${category}] ${message}`);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function regularFile(filePath, category) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    throw failure(category, `missing file: ${filePath} (${error.code ?? error.message})`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw failure(category, `expected a regular file: ${filePath}`);
  }
  return readFile(filePath);
}

async function exactEntries(directory, expected, category) {
  let entries;
  try {
    entries = (await readdir(directory)).sort();
  } catch (error) {
    throw failure(category, `cannot read directory: ${directory} (${error.code ?? error.message})`);
  }
  assertEqual(entries, [...expected].sort(), category, `unexpected entries in ${directory}`);
}

function assertEqual(actual, expected, category, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw failure(category, `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function treeManifest(root, category) {
  const manifest = new Map();
  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw failure(category, `cannot read directory: ${directory} (${error.code ?? error.message})`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw failure(category, `symbolic links are forbidden: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        manifest.set(relativePath, sha256(await readFile(absolutePath)));
      } else {
        throw failure(category, `unsupported filesystem entry: ${absolutePath}`);
      }
    }
  }
  await visit(root, "");
  return manifest;
}

async function mirroredTree(source, staged, category) {
  const [sourceManifest, stagedManifest] = await Promise.all([
    treeManifest(source, category),
    treeManifest(staged, category),
  ]);
  assertEqual(
    [...stagedManifest],
    [...sourceManifest],
    category,
    `staged tree differs from source: ${staged}`,
  );
  return stagedManifest.size;
}

async function copiedFile(source, staged, category) {
  const [sourceContents, stagedContents] = await Promise.all([
    regularFile(source, category),
    regularFile(staged, category),
  ]);
  if (sha256(sourceContents) !== sha256(stagedContents)) {
    throw failure(category, `staged file differs from source: ${staged}`);
  }
}

function assertWindowsIcon(contents) {
  if (contents.length < 6 || contents.readUInt16LE(0) !== 0 || contents.readUInt16LE(2) !== 1) {
    throw failure("icon", "icon.ico has an invalid ICO header");
  }
  const count = contents.readUInt16LE(4);
  if (contents.length < 6 + count * 16) {
    throw failure("icon", "icon.ico has a truncated directory");
  }
  const entries = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    const width = contents[offset] || 256;
    const height = contents[offset + 1] || 256;
    const bits = contents.readUInt16LE(offset + 6);
    const byteLength = contents.readUInt32LE(offset + 8);
    const imageOffset = contents.readUInt32LE(offset + 12);
    if (byteLength === 0 || imageOffset + byteLength > contents.length) {
      throw failure("icon", `icon.ico entry ${index} is outside the file`);
    }
    return `${width}x${height}x${bits}`;
  });
  assertEqual(
    [...entries].sort(),
    ["16x16x32", "24x24x32", "32x32x32", "48x48x32", "64x64x32", "256x256x32"].sort(),
    "icon",
    "icon.ico does not contain the reviewed image set",
  );
}

async function rejectForbiddenFiles(resourcesRoot) {
  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw failure(
        "forbidden files",
        `cannot read directory: ${directory} (${error.code ?? error.message})`,
      );
    }
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (
        forbiddenDirectoryNames.has(entry.name) ||
        forbiddenFileNames.has(entry.name) ||
        forbiddenFilePattern.test(entry.name)
      ) {
        throw failure("forbidden files", `development or sensitive entry found: ${relativePath}`);
      }
      if (entry.isSymbolicLink()) {
        throw failure("forbidden files", `symbolic links are forbidden: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath);
      } else if (!entry.isFile()) {
        throw failure("forbidden files", `unsupported filesystem entry: ${relativePath}`);
      }
    }
  }
  await visit(resourcesRoot, "");
}

export async function verifyWindowsResources({
  projectRoot = defaultProjectRoot,
  tauriRoot = path.join(projectRoot, "src-tauri"),
  expectations = defaultExpectations,
} = {}) {
  const resourcesRoot = path.join(tauriRoot, "resources");
  const appRoot = path.join(resourcesRoot, "app");
  await rejectForbiddenFiles(resourcesRoot);
  await exactEntries(resourcesRoot, ["app", "bin", "licenses"], "application resources");
  await exactEntries(
    appRoot,
    ["cli", "dist", "inject", "scripts", "server", "shared", "skills"],
    "application resources",
  );
  await exactEntries(path.join(appRoot, "dist"), ["web"], "application resources");
  await exactEntries(path.join(appRoot, "skills"), ["manage-taskboard"], "skill");
  await exactEntries(path.join(appRoot, "scripts"), selectedScripts, "application resources");
  await exactEntries(path.join(appRoot, "inject"), ["codex-taskboard.user.js"], "application resources");
  await exactEntries(path.join(appRoot, "cli"), ["taskctl.mjs"], "CLI");
  await exactEntries(path.join(resourcesRoot, "bin"), ["taskctl.cmd"], "CLI");
  await exactEntries(
    path.join(resourcesRoot, "licenses"),
    ["Lobe-Icons-LICENSE.txt", "Node-LICENSE"],
    "licenses",
  );

  let mirroredFileCount = 0;
  for (const [source, staged, category] of [
    ["server", "server", "application resources"],
    ["shared", "shared", "application resources"],
    [path.join("dist", "web"), path.join("dist", "web"), "application resources"],
    [path.join("skills", "manage-taskboard"), path.join("skills", "manage-taskboard"), "skill"],
  ]) {
    mirroredFileCount += await mirroredTree(
      path.join(projectRoot, source),
      path.join(appRoot, staged),
      category,
    );
  }
  for (const fileName of selectedScripts) {
    await copiedFile(
      path.join(projectRoot, "scripts", fileName),
      path.join(appRoot, "scripts", fileName),
      "application resources",
    );
  }
  await copiedFile(
    path.join(projectRoot, "inject", "codex-taskboard.user.js"),
    path.join(appRoot, "inject", "codex-taskboard.user.js"),
    "application resources",
  );
  await copiedFile(
    path.join(projectRoot, "cli", "taskctl.mjs"),
    path.join(appRoot, "cli", "taskctl.mjs"),
    "CLI",
  );
  await copiedFile(
    path.join(tauriRoot, "licenses", "Lobe-Icons-LICENSE.txt"),
    path.join(resourcesRoot, "licenses", "Lobe-Icons-LICENSE.txt"),
    "licenses",
  );

  const wrapper = await regularFile(path.join(resourcesRoot, "bin", "taskctl.cmd"), "CLI");
  if (wrapper.toString("utf8") !== windowsTaskctlWrapper()) {
    throw failure("CLI", "taskctl.cmd differs from the reviewed generated wrapper");
  }
  const nodeLicense = await regularFile(
    path.join(resourcesRoot, "licenses", "Node-LICENSE"),
    "licenses",
  );
  if (sha256(nodeLicense) !== expectations.nodeLicenseSha256) {
    throw failure("licenses", "Node-LICENSE checksum does not match the pinned runtime license");
  }

  const sidecar = await regularFile(
    path.join(tauriRoot, "binaries", "node-x86_64-pc-windows-msvc.exe"),
    "sidecar",
  );
  if (sha256(sidecar) !== expectations.nodeExecutableSha256) {
    throw failure("sidecar", "Windows Node sidecar checksum does not match the pinned release");
  }
  try {
    assertWindowsX64Pe(sidecar, "Windows Node sidecar");
  } catch (error) {
    throw failure("sidecar", error.message);
  }

  const icon = await regularFile(path.join(tauriRoot, "icons", "icon.ico"), "icon");
  if (sha256(icon) !== expectations.iconSha256) {
    throw failure("icon", "icon.ico checksum does not match the reviewed generated asset");
  }
  assertWindowsIcon(icon);
  return {
    target: "x86_64-pc-windows-msvc",
    mirroredFileCount,
    sidecarSha256: expectations.nodeExecutableSha256,
    iconSha256: expectations.iconSha256,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    throw new Error("Usage: verify-windows-resources.mjs [project-root]");
  }
  const projectRoot = argv[0] ? path.resolve(argv[0]) : defaultProjectRoot;
  const result = await verifyWindowsResources({ projectRoot });
  console.log(`Verified Windows staging resources (${result.mirroredFileCount} mirrored files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
