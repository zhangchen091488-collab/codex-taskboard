import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const initializationMarkerName = ".codex-taskboard-independent-profile-v1";
const leaseFileName = ".codex-taskboard-profile.lock";

export class CodexProfileError extends Error {
  constructor(message, { code, retryable }) {
    super(message);
    this.name = "CodexProfileError";
    this.code = code;
    this.retryable = retryable;
  }
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizedPath(value, platform) {
  const api = pathApi(platform);
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isSameOrDescendant(parentPath, candidatePath, platform) {
  const api = pathApi(platform);
  const relative = api.relative(
    normalizedPath(parentPath, platform),
    normalizedPath(candidatePath, platform),
  );
  return (
    relative === ""
    || (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative))
  );
}

export function profilePathsOverlap(sourceProfilePath, destinationProfilePath, {
  platform = process.platform,
} = {}) {
  return (
    isSameOrDescendant(sourceProfilePath, destinationProfilePath, platform)
    || isSameOrDescendant(destinationProfilePath, sourceProfilePath, platform)
  );
}

async function exists(filePath, inspect = lstat) {
  try {
    return await inspect(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeIfPresent(filePath, removeFile = unlink) {
  try {
    await removeFile(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function publishWithoutOverwrite(temporaryPath, destinationPath, {
  linkFile = link,
  removeFile = unlink,
} = {}) {
  try {
    await linkFile(temporaryPath, destinationPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await removeIfPresent(temporaryPath, removeFile);
  }
}

function profileOperationError(error) {
  const locked = (
    ["EACCES", "EBUSY", "EPERM"].includes(error?.code)
    || /\b(?:busy|locked|in use|sharing violation)\b/i.test(error?.message ?? "")
  );
  return new CodexProfileError(
    locked
      ? "The independent Codex profile is in use. Close the other Taskboard window and retry."
      : "The independent Codex profile could not be initialized safely. Retry the launch.",
    {
      code: locked ? "CODEX_PROFILE_LOCKED" : "CODEX_PROFILE_INITIALIZATION_FAILED",
      retryable: true,
    },
  );
}

function overlapError() {
  return new CodexProfileError(
    "The official and independent Codex profile directories must not overlap.",
    { code: "CODEX_PROFILE_PATHS_OVERLAP", retryable: false },
  );
}

export async function initializeIndependentCodexProfile({
  sourceProfilePath,
  destinationProfilePath,
  platform = process.platform,
  dependencies = {},
}) {
  if (!destinationProfilePath) throw overlapError();
  if (
    sourceProfilePath
    && profilePathsOverlap(sourceProfilePath, destinationProfilePath, { platform })
  ) {
    throw overlapError();
  }

  const inspect = dependencies.lstat ?? lstat;
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const resolveRealPath = dependencies.realpath ?? realpath;
  const linkFile = dependencies.link ?? link;
  const removeFile = dependencies.unlink ?? unlink;
  const write = dependencies.writeFile ?? writeFile;
  const createId = dependencies.randomUUID ?? randomUUID;
  const markerPath = path.join(destinationProfilePath, initializationMarkerName);

  try {
    const destinationMetadata = await exists(destinationProfilePath, inspect);
    if (destinationMetadata?.isSymbolicLink()) throw overlapError();
    const destinationExisted = Boolean(destinationMetadata);
    await makeDirectory(destinationProfilePath, { recursive: true });
    const canonicalDestination = await resolveRealPath(destinationProfilePath);
    if (sourceProfilePath) {
      let canonicalSource;
      try {
        canonicalSource = await resolveRealPath(sourceProfilePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (
        canonicalSource
        && profilePathsOverlap(canonicalSource, canonicalDestination, { platform })
      ) {
        throw overlapError();
      }
    }
    if (await exists(markerPath, inspect)) {
      return { status: "existing", markerPath };
    }

    const temporaryPath = `${markerPath}.${process.pid}-${createId()}.tmp`;
    try {
      await write(temporaryPath, "1\n", { flag: "wx" });
      await publishWithoutOverwrite(temporaryPath, markerPath, {
        linkFile,
        removeFile,
      });
    } catch (error) {
      await removeIfPresent(temporaryPath, removeFile);
      throw error;
    }
    return { status: destinationExisted ? "adopted" : "created", markerPath };
  } catch (error) {
    if (error instanceof CodexProfileError) throw error;
    throw profileOperationError(error);
  }
}

function processIsRunning(pid, signalProcess = process.kill) {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function lockedProfileError() {
  return new CodexProfileError(
    "The independent Codex profile is in use. Close the other Taskboard window and retry.",
    { code: "CODEX_PROFILE_LOCKED", retryable: true },
  );
}

export async function acquireCodexProfileLease(destinationProfilePath, {
  dependencies = {},
  pid = process.pid,
} = {}) {
  const linkFile = dependencies.link ?? link;
  const read = dependencies.readFile ?? readFile;
  const move = dependencies.rename ?? rename;
  const removeFile = dependencies.unlink ?? unlink;
  const write = dependencies.writeFile ?? writeFile;
  const createId = dependencies.randomUUID ?? randomUUID;
  const signalProcess = dependencies.kill ?? process.kill;
  const leasePath = path.join(destinationProfilePath, leaseFileName);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = createId();
    const temporaryPath = `${leasePath}.${pid}-${nonce}.tmp`;
    try {
      await write(temporaryPath, `${JSON.stringify({ version: 1, pid, nonce })}\n`, {
        flag: "wx",
      });
      const acquired = await publishWithoutOverwrite(temporaryPath, leasePath, {
        linkFile,
        removeFile,
      });
      if (acquired) {
        let released = false;
        return {
          leasePath,
          async release() {
            if (released) return;
            released = true;
            try {
              const record = JSON.parse(await read(leasePath, "utf8"));
              if (record.nonce === nonce && record.pid === pid) {
                await removeIfPresent(leasePath, removeFile);
              }
            } catch (error) {
              if (error?.code !== "ENOENT") throw profileOperationError(error);
            }
          },
        };
      }

      let record;
      try {
        record = JSON.parse(await read(leasePath, "utf8"));
      } catch {
        throw lockedProfileError();
      }
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
        throw lockedProfileError();
      }
      if (processIsRunning(record.pid, signalProcess)) throw lockedProfileError();

      const stalePath = `${leasePath}.stale-${pid}-${createId()}`;
      try {
        await move(leasePath, stalePath);
        await removeIfPresent(stalePath, removeFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } catch (error) {
      await removeIfPresent(temporaryPath, removeFile);
      if (error instanceof CodexProfileError) throw error;
      if (attempt === 2) throw profileOperationError(error);
    }
  }
  throw lockedProfileError();
}

export const codexProfileFileNames = Object.freeze({
  initializationMarkerName,
  leaseFileName,
});
