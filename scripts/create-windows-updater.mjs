#!/usr/bin/env node

import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import {
  updaterArtifactUrl,
  validateUpdaterFragment,
  WINDOWS_UPDATER_PLATFORMS,
} from "./updater-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

function canonicalArtifactName(version) {
  return `Codex.Taskboard_${version}_x64-setup.exe`;
}

export async function prepareWindowsUpdaterAsset({
  installerPath,
  signaturePath,
  outputDirectory,
  releaseTag,
  expectedVersion,
  publicKey,
}) {
  assert.equal(
    releaseTag,
    `v${expectedVersion}`,
    "Release tag does not match the Windows updater version",
  );
  assert.equal(
    path.extname(installerPath).toLowerCase(),
    ".exe",
    "Windows updater artifact must be an NSIS setup executable",
  );
  assert.equal(
    path.resolve(signaturePath),
    path.resolve(`${installerPath}.sig`),
    "Windows updater signature must use Tauri's setup.exe.sig path",
  );

  const installer = await readFile(installerPath);
  assert.ok(
    installer.length > 2 && installer.subarray(0, 2).equals(Buffer.from("MZ")),
    "Windows updater artifact is not a PE executable",
  );
  const signature = await readFile(signaturePath, "utf8");
  await verifyUpdaterSignature({ publicKey, artifactPath: installerPath, signature });

  const artifactName = canonicalArtifactName(expectedVersion);
  const destination = path.join(outputDirectory, artifactName);
  const destinationSignature = `${destination}.sig`;
  const metadataPath = path.join(outputDirectory, "windows-updater.json");
  await mkdir(outputDirectory, { recursive: true });
  const fragment = {
    schemaVersion: 1,
    version: expectedVersion,
    platforms: {
      "windows-x86_64": {
        artifact: artifactName,
        signature,
        url: updaterArtifactUrl(expectedVersion, artifactName),
      },
    },
  };
  validateUpdaterFragment(fragment, {
    expectedVersion,
    allowedPlatforms: WINDOWS_UPDATER_PLATFORMS,
  });
  const createdPaths = [];
  try {
    await copyFile(installerPath, destination, constants.COPYFILE_EXCL);
    createdPaths.push(destination);
    await copyFile(signaturePath, destinationSignature, constants.COPYFILE_EXCL);
    createdPaths.push(destinationSignature);
    await writeFile(metadataPath, `${JSON.stringify(fragment, null, 2)}\n`, { flag: "wx" });
    createdPaths.push(metadataPath);
  } catch (error) {
    await Promise.all(createdPaths.map((createdPath) => rm(createdPath, { force: true })));
    throw error;
  }
  return fragment;
}

export async function main(argv = process.argv.slice(2)) {
  const [installerArgument, outputArgument, releaseTag] = argv;
  if (!installerArgument || !outputArgument || !releaseTag) {
    throw new Error(
      "Usage: create-windows-updater.mjs <setup.exe> <output-directory> <release-tag>",
    );
  }
  const installerPath = path.resolve(installerArgument);
  const outputDirectory = path.resolve(outputArgument);
  const [packageJson, tauriConfig] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
  ]);
  const fragment = await prepareWindowsUpdaterAsset({
    installerPath,
    signaturePath: `${installerPath}.sig`,
    outputDirectory,
    releaseTag,
    expectedVersion: packageJson.version,
    publicKey: tauriConfig.plugins.updater.pubkey,
  });
  const artifact = fragment.platforms["windows-x86_64"].artifact;
  console.log(`Verified and staged ${artifact} with Tauri updater signature`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
