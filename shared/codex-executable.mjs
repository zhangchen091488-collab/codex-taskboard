import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function executableFile(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(env, platform) {
  if (platform !== "win32") return ["codex"];

  const configured = typeof env.PATHEXT === "string" && env.PATHEXT.trim()
    ? env.PATHEXT
    : DEFAULT_WINDOWS_PATHEXT;
  const extensions = [];
  const seen = new Set();
  for (const value of configured.split(";")) {
    const extension = value.trim().startsWith(".") ? value.trim() : `.${value.trim()}`;
    if (!/^\.[a-z0-9]+$/i.test(extension)) continue;
    const key = extension.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extensions.push(extension);
  }
  return extensions.map((extension) => `codex${extension}`);
}

function pathDirectory(value, platform) {
  if (platform === "win32" && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function executableOnPath(env, platform, isExecutable) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  for (const value of String(env.PATH || "").split(pathApi.delimiter)) {
    const directory = pathDirectory(value, platform);
    if (!directory) continue;
    for (const name of executableNames(env, platform)) {
      const candidate = pathApi.join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function codexExecutableInApp(appPath) {
  return path.posix.join(appPath, "Contents", "Resources", "codex");
}

export function resolveCodexExecutable({
  explicit = process.env.CODEX_EXECUTABLE,
  appPath,
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
  isExecutable,
} = {}) {
  const checkExecutable = isExecutable
    ?? ((candidate) => executableFile(candidate, platform));
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  if (appPath && platform === "darwin") {
    const bundled = codexExecutableInApp(appPath);
    if (checkExecutable(bundled)) return bundled;
  }

  const installedCli = executableOnPath(env, platform, checkExecutable);
  if (installedCli) return installedCli;

  if (platform === "darwin") {
    for (const applicationDirectory of [
      "/Applications",
      path.posix.join(homeDirectory, "Applications"),
    ]) {
      for (const applicationName of ["ChatGPT.app", "Codex.app"]) {
        const bundled = codexExecutableInApp(path.join(applicationDirectory, applicationName));
        if (checkExecutable(bundled)) return bundled;
      }
    }
  }

  return "codex";
}
