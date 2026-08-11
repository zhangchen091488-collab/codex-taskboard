import { spawn } from "node:child_process";
import path from "node:path";

import { withoutTaskboardLauncherEnvironment } from "./codex-environment.mjs";

export const CODEX_ELECTRON_USER_DATA_PATH_ENV = "CODEX_ELECTRON_USER_DATA_PATH";

export function codexAppExecutablePath(appPath, {
  platform = process.platform,
} = {}) {
  if (platform === "win32") return path.win32.normalize(appPath);
  return path.join(
    appPath,
    "Contents",
    "MacOS",
    path.basename(appPath, ".app"),
  );
}

export function codexIndependentLaunchArguments(profilePath) {
  return [`--user-data-dir=${profilePath}`];
}

export function launchIndependentCodexApp({
  appPath,
  profilePath,
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
}) {
  return spawnProcess(
    codexAppExecutablePath(appPath, { platform }),
    codexIndependentLaunchArguments(profilePath),
    {
      env: {
        ...withoutTaskboardLauncherEnvironment(environment),
        [CODEX_ELECTRON_USER_DATA_PATH_ENV]: profilePath,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
}
