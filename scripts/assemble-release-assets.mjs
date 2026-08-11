#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mergeUpdaterManifestFiles } from "./merge-updater-manifests.mjs";
import {
  createUpdaterManifest,
  DARWIN_UPDATER_PLATFORMS,
} from "./updater-manifest.mjs";
import { verifyReleaseUpdaterAssets } from "./verify-release-updater.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

function namesForVersion(version) {
  const macArchive = `Codex.Taskboard_${version}_universal.app.tar.gz`;
  const windowsSetup = `Codex.Taskboard_${version}_x64-setup.exe`;
  return {
    macInput: [
      `Codex.Taskboard_${version}_universal.dmg`,
      macArchive,
      `${macArchive}.sig`,
      "darwin-updater.json",
      "latest.json",
    ].sort(),
    windowsInput: [
      windowsSetup,
      `${windowsSetup}.sig`,
      "windows-updater.json",
    ].sort(),
  };
}

async function exactNames(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  assert.ok(entries.every((entry) => entry.isFile()), `${directory} must contain files only`);
  return entries.map((entry) => entry.name).sort();
}

function parseSha256Manifest(source) {
  const records = new Map();
  for (const line of source.trimEnd().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})  ([^/\\\r\n]+)$/.exec(line);
    assert.ok(match, "Trusted release manifest contains an invalid record");
    assert.ok(!records.has(match[2]), `Trusted release manifest duplicates ${match[2]}`);
    records.set(match[2], match[1]);
  }
  return records;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function assertOutside(parentPath, candidatePath, message) {
  const relative = path.relative(parentPath, candidatePath);
  assert.ok(
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    message,
  );
}

export async function assembleReleaseAssets({
  macDirectory,
  windowsDirectory,
  macManifestPath,
  outputDirectory,
  outputManifestPath,
  expectedVersion,
  publicKey,
}) {
  macDirectory = path.resolve(macDirectory);
  windowsDirectory = path.resolve(windowsDirectory);
  macManifestPath = path.resolve(macManifestPath);
  outputDirectory = path.resolve(outputDirectory);
  outputManifestPath = path.resolve(outputManifestPath);
  assertOutside(macDirectory, outputDirectory, "Output must be outside the macOS baseline");
  assertOutside(windowsDirectory, outputDirectory, "Output must be outside Windows staging");
  assertOutside(outputDirectory, outputManifestPath, "Trusted output manifest must be outside assets");
  assertOutside(macDirectory, outputManifestPath, "Trusted output manifest must not modify macOS input");
  assertOutside(
    windowsDirectory,
    outputManifestPath,
    "Trusted output manifest must not modify Windows input",
  );

  const names = namesForVersion(expectedVersion);
  assert.deepEqual(await exactNames(macDirectory), names.macInput, "macOS Draft baseline is incorrect");
  assert.deepEqual(
    await exactNames(windowsDirectory),
    names.windowsInput,
    "Windows release staging is incorrect",
  );

  const trustedMac = parseSha256Manifest(await readFile(macManifestPath, "utf8"));
  assert.deepEqual(
    [...trustedMac.keys()].sort(),
    names.macInput,
    "Trusted macOS manifest has an incorrect asset set",
  );
  for (const [name, digest] of trustedMac) {
    assert.equal(await sha256(path.join(macDirectory, name)), digest, `${name} SHA-256 mismatch`);
  }

  const [darwinFragment, darwinLatest] = await Promise.all([
    readFile(path.join(macDirectory, "darwin-updater.json"), "utf8").then(JSON.parse),
    readFile(path.join(macDirectory, "latest.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(
    darwinLatest,
    createUpdaterManifest({
      fragments: [darwinFragment],
      expectedVersion,
      requiredPlatforms: DARWIN_UPDATER_PLATFORMS,
      pubDate: darwinLatest.pub_date,
    }),
    "macOS Draft latest.json does not match its Darwin fragment",
  );

  let outputCreated = false;
  let manifestCreated = false;
  try {
    await mkdir(outputDirectory);
    outputCreated = true;
    const copiedNames = [
      ...names.macInput.filter((name) => name !== "latest.json"),
      ...names.windowsInput,
    ];
    for (const name of copiedNames) {
      const sourceDirectory = names.windowsInput.includes(name)
        ? windowsDirectory
        : macDirectory;
      await copyFile(path.join(sourceDirectory, name), path.join(outputDirectory, name));
    }
    await mergeUpdaterManifestFiles({
      fragmentPaths: [
        path.join(outputDirectory, "darwin-updater.json"),
        path.join(outputDirectory, "windows-updater.json"),
      ],
      outputPath: path.join(outputDirectory, "latest.json"),
      expectedVersion,
      pubDate: darwinLatest.pub_date,
    });

    const expectedFinalNames = [
      ...names.macInput.filter((name) => name !== "latest.json"),
      ...names.windowsInput,
      "latest.json",
    ].sort();
    assert.deepEqual(
      await exactNames(outputDirectory),
      expectedFinalNames,
      "Final release asset set is incorrect",
    );
    const updater = await verifyReleaseUpdaterAssets({
      releaseDirectory: outputDirectory,
      expectedVersion,
      publicKey,
    });
    const manifestLines = [];
    for (const name of expectedFinalNames) {
      manifestLines.push(`${await sha256(path.join(outputDirectory, name))}  ${name}`);
    }
    await writeFile(outputManifestPath, `${manifestLines.join("\n")}\n`, { flag: "wx" });
    manifestCreated = true;
    return { assets: expectedFinalNames, updater };
  } catch (error) {
    if (manifestCreated) await rm(outputManifestPath, { force: true });
    if (outputCreated) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [macDirectory, windowsDirectory, macManifestPath, outputDirectory, outputManifestPath] = argv;
  if (argv.length !== 5) {
    throw new Error(
      "Usage: assemble-release-assets.mjs <mac-directory> <windows-directory> " +
      "<mac-manifest> <output-directory> <output-manifest>",
    );
  }
  const [packageJson, tauriConfig] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
  ]);
  const result = await assembleReleaseAssets({
    macDirectory: path.resolve(macDirectory),
    windowsDirectory: path.resolve(windowsDirectory),
    macManifestPath: path.resolve(macManifestPath),
    outputDirectory: path.resolve(outputDirectory),
    outputManifestPath: path.resolve(outputManifestPath),
    expectedVersion: packageJson.version,
    publicKey: tauriConfig.plugins.updater.pubkey,
  });
  console.log(`Assembled trusted release assets: ${JSON.stringify(result)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
