#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  createUpdaterManifest,
  DARWIN_UPDATER_PLATFORMS,
  updaterArtifactUrl,
} from "./updater-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const outputDirectory = process.argv[3] ? path.resolve(process.argv[3]) : null;
const releaseTag = process.argv[4]?.trim();

if (!appPath || !outputDirectory || !releaseTag) {
  throw new Error("Usage: create-macos-updater.mjs <App.app> <output-directory> <release-tag>");
}

const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
if (releaseTag !== `v${packageJson.version}`) {
  throw new Error("Release tag does not match package.json version");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
  }
}

await mkdir(outputDirectory, { recursive: true });
const artifactName = `Codex.Taskboard_${packageJson.version}_universal.app.tar.gz`;
const artifactPath = path.join(outputDirectory, artifactName);
run("/usr/bin/tar", ["-czf", artifactPath, path.basename(appPath)], {
  cwd: path.dirname(appPath),
});
run(path.join(projectRoot, "node_modules", ".bin", "tauri"), ["signer", "sign", artifactPath]);

const signature = await readFile(`${artifactPath}.sig`, "utf8");
const platform = {
  artifact: artifactName,
  signature,
  url: updaterArtifactUrl(packageJson.version, artifactName),
};
const fragment = {
  schemaVersion: 1,
  version: packageJson.version,
  platforms: Object.fromEntries(
    DARWIN_UPDATER_PLATFORMS.map((target) => [target, platform]),
  ),
};
const latest = createUpdaterManifest({
  fragments: [fragment],
  expectedVersion: packageJson.version,
  requiredPlatforms: DARWIN_UPDATER_PLATFORMS,
  pubDate: new Date().toISOString(),
});
await writeFile(
  path.join(outputDirectory, "darwin-updater.json"),
  `${JSON.stringify(fragment, null, 2)}\n`,
);
await writeFile(path.join(outputDirectory, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
console.log(
  `Created ${artifactPath}, ${artifactPath}.sig, darwin-updater.json, and latest.json`,
);
