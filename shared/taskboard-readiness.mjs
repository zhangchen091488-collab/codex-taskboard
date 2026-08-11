export const TASKBOARD_READINESS_TYPE = "codex-taskboard:readiness";
export const TASKBOARD_READINESS_VERSION = 1;

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

export function listeningReadiness(port) {
  return {
    type: TASKBOARD_READINESS_TYPE,
    version: TASKBOARD_READINESS_VERSION,
    status: "listening",
    host: "127.0.0.1",
    port,
  };
}

export function errorReadiness() {
  return {
    type: TASKBOARD_READINESS_TYPE,
    version: TASKBOARD_READINESS_VERSION,
    status: "error",
    code: "LISTEN_FAILED",
  };
}

export function parseTaskboardReadiness(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Taskboard readiness message must be an object");
  }
  if (value.type !== TASKBOARD_READINESS_TYPE || value.version !== TASKBOARD_READINESS_VERSION) {
    throw new Error("Taskboard readiness message has an unsupported type or version");
  }
  if (value.status === "listening") {
    if (!exactKeys(value, ["type", "version", "status", "host", "port"])) {
      throw new Error("Taskboard listening readiness message has unexpected fields");
    }
    if (value.host !== "127.0.0.1") {
      throw new Error("Taskboard readiness host must be 127.0.0.1");
    }
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new Error("Taskboard readiness port must be an integer between 1 and 65535");
    }
    return { ...value };
  }
  if (value.status === "error") {
    if (!exactKeys(value, ["type", "version", "status", "code"])) {
      throw new Error("Taskboard error readiness message has unexpected fields");
    }
    if (value.code !== "LISTEN_FAILED") {
      throw new Error("Taskboard readiness error code is not supported");
    }
    return { ...value };
  }
  throw new Error("Taskboard readiness status is not supported");
}

export function createTaskboardReadinessTracker() {
  let terminalMessage = null;
  return {
    accept(value) {
      if (terminalMessage) {
        throw new Error("Taskboard readiness message was sent more than once");
      }
      terminalMessage = parseTaskboardReadiness(value);
      return terminalMessage;
    },
    timeout() {
      if (!terminalMessage) throw new Error("Timed out waiting for Taskboard readiness");
      return terminalMessage;
    },
  };
}
