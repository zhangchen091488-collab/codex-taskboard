import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function safeName(value, field) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) {
    throw new Error(`${field} must be a simple file name`);
  }
  return value;
}

function regularFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function existingRegularFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function externalHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("External URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("External URL must be HTTPS and must not contain credentials");
  }
  return url.href;
}

export function openExternalCommand(value, {
  platform = process.platform,
  environment = process.env,
} = {}) {
  const url = externalHttpsUrl(value);
  let command;
  if (platform === "darwin") {
    command = "/usr/bin/open";
  } else if (platform === "win32") {
    const systemRoot = environment.SystemRoot
      || environment.SYSTEMROOT
      || environment.WINDIR
      || environment.windir;
    command = systemRoot ? path.win32.join(systemRoot, "explorer.exe") : "explorer.exe";
  } else if (platform === "linux") {
    command = "xdg-open";
  } else {
    throw new Error(`Opening external URLs is not supported on platform '${platform}'`);
  }
  return {
    command,
    args: [url],
    options: {
      detached: true,
      env: environment,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  };
}

export async function openExternal(value, {
  spawnProcess = spawn,
  ...commandOptions
} = {}) {
  const descriptor = openExternalCommand(value, commandOptions);
  await new Promise((resolve, reject) => {
    const child = spawnProcess(descriptor.command, descriptor.args, descriptor.options);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return { opened: true };
}

export function temporaryDirectoryPrefix(name, {
  platform = process.platform,
  temporaryRoot = os.tmpdir(),
} = {}) {
  return pathApi(platform).join(
    temporaryRoot,
    `${safeName(name, "Temporary directory name")}-`,
  );
}

export function createTemporaryDirectory(name, {
  makeTemporaryDirectory = mkdtemp,
  ...prefixOptions
} = {}) {
  return makeTemporaryDirectory(temporaryDirectoryPrefix(name, prefixOptions));
}

export function resolveLocalBin(projectRoot, name, {
  platform = process.platform,
  isFile = regularFile,
} = {}) {
  const api = pathApi(platform);
  const binName = safeName(name, "Local command name");
  const candidates = platform === "win32"
    ? [`${binName}.cmd`, `${binName}.exe`, binName]
    : [binName];
  for (const candidateName of candidates) {
    const candidate = api.join(projectRoot, "node_modules", ".bin", candidateName);
    if (isFile(candidate)) return candidate;
  }
  throw new Error(`Local command '${binName}' was not found under node_modules/.bin`);
}

export function resolveNodePackageBin(projectRoot, packageName, binName = packageName, {
  platform = process.platform,
  nodeExecutable = process.execPath,
  readManifest = (manifestPath) => JSON.parse(readFileSync(manifestPath, "utf8")),
  isFile = existingRegularFile,
} = {}) {
  const api = pathApi(platform);
  const safePackageName = safeName(packageName, "Package name");
  const safeBinName = safeName(binName, "Package command name");
  const packageRoot = api.join(projectRoot, "node_modules", safePackageName);
  const manifest = readManifest(api.join(packageRoot, "package.json"));
  const relativeEntry = typeof manifest?.bin === "string"
    ? manifest.bin
    : manifest?.bin?.[safeBinName];
  if (typeof relativeEntry !== "string" || !relativeEntry.trim()) {
    throw new Error(`Package '${safePackageName}' does not define command '${safeBinName}'`);
  }
  const entryPath = api.resolve(packageRoot, relativeEntry);
  const relative = api.relative(packageRoot, entryPath);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${api.sep}`)
    || api.isAbsolute(relative)
    || !isFile(entryPath)
  ) {
    throw new Error(`Package command '${safeBinName}' does not resolve to a local file`);
  }
  return {
    command: nodeExecutable,
    args: [entryPath],
    options: { shell: false, windowsHide: true },
  };
}
