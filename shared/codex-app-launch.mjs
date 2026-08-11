import { spawn } from "node:child_process";
import path from "node:path";

import { withoutTaskboardLauncherEnvironment } from "./codex-environment.mjs";

export const CODEX_ELECTRON_USER_DATA_PATH_ENV = "CODEX_ELECTRON_USER_DATA_PATH";

export function codexAppExecutablePath(appPath, {
  platform = process.platform,
} = {}) {
  if (platform === "win32") return path.win32.normalize(appPath);
  return path.posix.join(
    appPath,
    "Contents",
    "MacOS",
    path.posix.basename(appPath, ".app"),
  );
}

export function codexIndependentLaunchArguments(profilePath) {
  return [`--user-data-dir=${profilePath}`];
}

export function codexAppEnvironment(profilePath, environment = process.env) {
  return {
    ...withoutTaskboardLauncherEnvironment(environment),
    [CODEX_ELECTRON_USER_DATA_PATH_ENV]: profilePath,
  };
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
      env: codexAppEnvironment(profilePath, environment),
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

export function launchCodexAppWithPrivatePipe({
  appPath,
  profilePath,
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
}) {
  return spawnProcess(
    codexAppExecutablePath(appPath, { platform }),
    [
      ...codexIndependentLaunchArguments(profilePath),
      "--remote-debugging-pipe",
    ],
    {
      env: codexAppEnvironment(profilePath, environment),
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}
