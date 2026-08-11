#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createUpdaterManifest,
  RELEASE_UPDATER_PLATFORMS,
} from "./updater-manifest.mjs";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

export async function verifyReleaseUpdaterAssets({
  releaseDirectory,
  expectedVersion,
  publicKey,
}) {
  const [latest, darwinFragment, windowsFragment] = await Promise.all([
    readFile(path.join(releaseDirectory, "latest.json"), "utf8").then(JSON.parse),
    readFile(path.join(releaseDirectory, "darwin-updater.json"), "utf8").then(JSON.parse),
    readFile(path.join(releaseDirectory, "windows-updater.json"), "utf8").then(JSON.parse),
  ]);
  const expected = createUpdaterManifest({
    fragments: [darwinFragment, windowsFragment],
    expectedVersion,
    requiredPlatforms: RELEASE_UPDATER_PLATFORMS,
    pubDate: latest.pub_date,
  });
  assert.deepEqual(latest, expected, "latest.json does not match the reviewed platform fragments");

  const artifacts = new Map();
  for (const fragment of [darwinFragment, windowsFragment]) {
    for (const entry of Object.values(fragment.platforms)) {
      const existing = artifacts.get(entry.artifact);
      if (existing !== undefined) {
        assert.equal(existing, entry.signature, `${entry.artifact} has inconsistent signatures`);
      } else {
        artifacts.set(entry.artifact, entry.signature);
      }
    }
  }
  for (const [artifact, signature] of artifacts) {
    const artifactPath = path.join(releaseDirectory, artifact);
    const signaturePath = `${artifactPath}.sig`;
    const detachedSignature = (await readFile(signaturePath, "utf8")).trim();
    assert.equal(
      detachedSignature,
      signature.trim(),
      `${artifact}.sig does not match its updater fragment`,
    );
    await verifyUpdaterSignature({ publicKey, artifactPath, signature });
  }
  return {
    version: expectedVersion,
    platforms: Object.keys(latest.platforms).sort(),
    artifacts: [...artifacts.keys()].sort(),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const [releaseDirectoryArgument] = argv;
  if (!releaseDirectoryArgument || argv.length !== 1) {
    throw new Error("Usage: verify-release-updater.mjs <release-directory>");
  }
  const [packageJson, tauriConfig] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
  ]);
  const result = await verifyReleaseUpdaterAssets({
    releaseDirectory: path.resolve(releaseDirectoryArgument),
    expectedVersion: packageJson.version,
    publicKey: tauriConfig.plugins.updater.pubkey,
  });
  console.log(`Verified release updater assets: ${JSON.stringify(result)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
