import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

export const CODEX_TRANSPORT_READINESS_TYPE = "codex-taskboard:cdp-transport";
export const CODEX_TRANSPORT_READINESS_VERSION = 1;
export const CODEX_TRANSPORT_ERROR_CODE = "CDP_TRANSPORT_FAILED";

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function validNonce(nonce) {
  return typeof nonce === "string" && /^[a-z0-9-]{1,100}$/i.test(nonce);
}

export function readyCodexTransport(nonce) {
  if (!validNonce(nonce)) throw new Error("Codex transport nonce must be an identifier");
  return {
    type: CODEX_TRANSPORT_READINESS_TYPE,
    version: CODEX_TRANSPORT_READINESS_VERSION,
    status: "ready",
    transport: "pipe",
    nonce,
  };
}

export function errorCodexTransport(nonce) {
  if (!validNonce(nonce)) throw new Error("Codex transport nonce must be an identifier");
  return {
    type: CODEX_TRANSPORT_READINESS_TYPE,
    version: CODEX_TRANSPORT_READINESS_VERSION,
    status: "error",
    code: CODEX_TRANSPORT_ERROR_CODE,
    nonce,
  };
}

export function parseCodexTransportReadiness(value, expectedNonce) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex transport readiness must be an object");
  }
  if (
    value.type !== CODEX_TRANSPORT_READINESS_TYPE
    || value.version !== CODEX_TRANSPORT_READINESS_VERSION
    || value.nonce !== expectedNonce
  ) {
    throw new Error("Codex transport readiness header is invalid");
  }
  if (value.status === "ready") {
    if (!exactKeys(value, ["type", "version", "status", "transport", "nonce"])) {
      throw new Error("Codex transport ready message has unexpected fields");
    }
    if (value.transport !== "pipe") {
      throw new Error("Codex transport readiness must use a private pipe");
    }
    return { ...value };
  }
  if (value.status === "error") {
    if (!exactKeys(value, ["type", "version", "status", "code", "nonce"])) {
      throw new Error("Codex transport error message has unexpected fields");
    }
    if (value.code !== CODEX_TRANSPORT_ERROR_CODE) {
      throw new Error("Codex transport error code is unsupported");
    }
    return { ...value };
  }
  throw new Error("Codex transport readiness status is unsupported");
}

async function removeIfPresent(filePath, removeFile) {
  try {
    await removeFile(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function publishCodexTransportReadiness(filePath, value, {
  moveFile = rename,
  removeFile = unlink,
  write = writeFile,
  createId = randomUUID,
} = {}) {
  const readiness = parseCodexTransportReadiness(value, value?.nonce);
  const temporaryPath = `${filePath}.${process.pid}-${createId()}.tmp`;
  try {
    await write(temporaryPath, `${JSON.stringify(readiness)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await moveFile(temporaryPath, filePath);
  } catch (error) {
    await removeIfPresent(temporaryPath, removeFile);
    throw error;
  }
}
