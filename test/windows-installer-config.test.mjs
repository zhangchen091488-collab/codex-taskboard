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

  const customUninstall = structuredClone(baseInput);
  customUninstall.windowsConfig.bundle.windows.nsis.installerHooks = "windows-hooks.nsh";
  assert.throws(
    () => validateWindowsInstallerConfiguration(customUninstall),
    /data-retention audit/,
  );
});
