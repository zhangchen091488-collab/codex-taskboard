#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createUpdaterManifest,
  RELEASE_UPDATER_PLATFORMS,
} from "./updater-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

export async function mergeUpdaterManifestFiles({
  fragmentPaths,
  outputPath,
  expectedVersion,
  pubDate,
}) {
  const fragments = await Promise.all(fragmentPaths.map(
    (fragmentPath) => readFile(fragmentPath, "utf8").then(JSON.parse),
  ));
  const manifest = createUpdaterManifest({
    fragments,
    expectedVersion,
    requiredPlatforms: RELEASE_UPDATER_PLATFORMS,
    pubDate,
  });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  const [outputArgument, ...fragmentArguments] = argv;
  if (!outputArgument || fragmentArguments.length < 2) {
    throw new Error(
      "Usage: merge-updater-manifests.mjs <latest.json> <darwin-fragment> <windows-fragment>",
    );
  }
  const packageJson = JSON.parse(await readFile(
    path.join(projectRoot, "package.json"),
    "utf8",
  ));
  const manifest = await mergeUpdaterManifestFiles({
    fragmentPaths: fragmentArguments.map((argument) => path.resolve(argument)),
    outputPath: path.resolve(outputArgument),
    expectedVersion: packageJson.version,
    pubDate: new Date().toISOString(),
  });
  console.log(`Created updater manifest for ${Object.keys(manifest.platforms).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
