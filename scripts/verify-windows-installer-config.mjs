#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTauriBuildPlan } from "./build-tauri-app.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

export function validateWindowsInstallerConfiguration({
  baseConfig,
  windowsConfig,
  buildPlan,
}) {
  assert.deepEqual(windowsConfig.bundle?.targets, ["nsis"]);
  assert.deepEqual(windowsConfig.bundle?.icon, ["icons/icon.ico"]);
  assert.equal(windowsConfig.bundle?.createUpdaterArtifacts, false);
  assert.equal(
    windowsConfig.bundle?.windows?.nsis?.installMode,
    "currentUser",
    "Windows NSIS must not require machine-wide installation",
  );
  assert.equal(
    windowsConfig.bundle?.windows?.nsis?.installerIcon,
    "icons/icon.ico",
  );
  assert.deepEqual(
    windowsConfig.bundle?.windows?.webviewInstallMode,
    { type: "downloadBootstrapper", silent: true },
    "Windows installer WebView2 behavior must be explicit and reviewed",
  );
  assert.equal(
    windowsConfig.bundle?.windows?.minimumWebview2Version,
    undefined,
    "Do not pin an arbitrary WebView2 minimum without a tested feature requirement",
  );
  assert.equal(
    windowsConfig.bundle?.windows?.nsis?.template,
    undefined,
    "A custom NSIS template requires a new uninstall data-retention audit",
  );
  assert.equal(
    windowsConfig.bundle?.windows?.nsis?.installerHooks,
    undefined,
    "Custom NSIS hooks require a new uninstall data-retention audit",
  );
  assert.ok(baseConfig.bundle?.externalBin?.includes("binaries/node"));
  assert.equal(baseConfig.bundle?.resources?.["resources/"], "");

  const buildArguments = buildPlan.steps.at(-1)?.args ?? [];
  assert.ok(buildArguments.includes("--no-sign"));
  const bundlesIndex = buildArguments.indexOf("--bundles");
  assert.equal(buildArguments[bundlesIndex + 1], "nsis");
  const configIndex = buildArguments.indexOf("--config");
  assert.deepEqual(JSON.parse(buildArguments[configIndex + 1]), {
    bundle: { createUpdaterArtifacts: false },
  });
}

export async function verifyWindowsInstallerConfiguration() {
  const [baseConfig, windowsConfig] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "tauri.windows.conf.json"), "utf8").then(JSON.parse),
  ]);
  await Promise.all([
    access(path.join(projectRoot, "src-tauri", "icons", "icon.ico")),
    access(
      path.join(
        projectRoot,
        "src-tauri",
        "binaries",
        "node-x86_64-pc-windows-msvc.exe",
      ),
    ),
  ]);
  const buildPlan = createTauriBuildPlan([], {
    hostPlatform: "win32",
    nodeExecutable: process.execPath,
    npmCliPath: path.join(projectRoot, "node_modules", "npm", "bin", "npm-cli.js"),
  });
  validateWindowsInstallerConfiguration({ baseConfig, windowsConfig, buildPlan });
  return {
    installMode: windowsConfig.bundle.windows.nsis.installMode,
    target: buildPlan.target,
    bundle: "nsis",
    updaterArtifacts: false,
    bundledNode: true,
    webview2: "downloadBootstrapper",
  };
}

export async function main() {
  const result = await verifyWindowsInstallerConfiguration();
  console.log(`Verified unsigned Windows installer policy: ${JSON.stringify(result)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
