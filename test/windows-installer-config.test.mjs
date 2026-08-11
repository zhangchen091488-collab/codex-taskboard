import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateWindowsInstallerConfiguration,
  verifyWindowsInstallerConfiguration,
} from "../scripts/verify-windows-installer-config.mjs";

test("Windows unsigned installer is current-user NSIS with bundled Node", async () => {
  assert.deepEqual(await verifyWindowsInstallerConfiguration(), {
    installMode: "currentUser",
    target: "x86_64-pc-windows-msvc",
    bundle: "nsis",
    updaterArtifacts: false,
    bundledNode: true,
    allowDowngrades: false,
    webview2: "downloadBootstrapper",
  });
});

test("installer policy rejects machine-wide mode and unaudited uninstall hooks", () => {
  const baseInput = {
    baseConfig: {
      bundle: {
        externalBin: ["binaries/node"],
        resources: { "resources/": "" },
      },
    },
    windowsConfig: {
      bundle: {
        createUpdaterArtifacts: false,
        targets: ["nsis"],
        icon: ["icons/icon.ico"],
        windows: {
          allowDowngrades: false,
          webviewInstallMode: {
            type: "downloadBootstrapper",
            silent: true,
          },
          nsis: {
            installMode: "currentUser",
            installerIcon: "icons/icon.ico",
          },
        },
      },
    },
    buildPlan: {
      steps: [{ args: [
        "tauri.js",
        "build",
        "--bundles",
        "nsis",
        "--no-sign",
        "--config",
        '{"bundle":{"createUpdaterArtifacts":false}}',
      ] }],
    },
  };

  const machineWide = structuredClone(baseInput);
  machineWide.windowsConfig.bundle.windows.nsis.installMode = "perMachine";
  assert.throws(
    () => validateWindowsInstallerConfiguration(machineWide),
    /machine-wide installation/,
  );

  const downgradeAllowed = structuredClone(baseInput);
  downgradeAllowed.windowsConfig.bundle.windows.allowDowngrades = true;
  assert.throws(
    () => validateWindowsInstallerConfiguration(downgradeAllowed),
    /reject accidental downgrades/,
  );

  const customUninstall = structuredClone(baseInput);
  customUninstall.windowsConfig.bundle.windows.nsis.installerHooks = "windows-hooks.nsh";
  assert.throws(
    () => validateWindowsInstallerConfiguration(customUninstall),
    /data-retention audit/,
  );

  const skippedWebView = structuredClone(baseInput);
  skippedWebView.windowsConfig.bundle.windows.webviewInstallMode = { type: "skip" };
  assert.throws(
    () => validateWindowsInstallerConfiguration(skippedWebView),
    /WebView2 behavior must be explicit/,
  );

  const arbitraryMinimum = structuredClone(baseInput);
  arbitraryMinimum.windowsConfig.bundle.windows.minimumWebview2Version = "999.0.0.0";
  assert.throws(
    () => validateWindowsInstallerConfiguration(arbitraryMinimum),
    /arbitrary WebView2 minimum/,
  );
});
