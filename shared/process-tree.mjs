import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";

export const PROCESS_STOP_RESULT = Object.freeze({
  ALREADY_EXITED: "already-exited",
  EXITED: "exited",
  TIMED_OUT: "timed-out",
});

const MAX_WINDOWS_PID = 0xffff_ffff;

function validatedPid(pid, label) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_WINDOWS_PID) {
    throw new TypeError(`${label} must be a positive 32-bit integer`);
  }
  return pid;
}

function childPid(child) {
  return validatedPid(child?.pid, "Managed child PID");
}

export function isProcessRunning(pid, { processKill = process.kill } = {}) {
  validatedPid(pid, "Process PID");
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function forceStopOwnedUnixProcessGroup(
  rootPid,
  { processKill = process.kill } = {},
) {
  const pid = validatedPid(rootPid, "Owned process-group root PID");
  try {
    processKill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function isManagedChildRunning(child) {
  if (!child) return false;
  childPid(child);
  if (child.exitCode !== null || child.signalCode !== null) return false;
  return true;
}

function isUnixProcessGroupRunning(child, processKill) {
  const pid = childPid(child);
  try {
    processKill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function isManagedProcessTreeRunning(
  child,
  { detached = false, platform = process.platform, processKill = process.kill } = {},
) {
  if (!child) return false;
  if (platform !== "win32" && detached) {
    return isUnixProcessGroupRunning(child, processKill);
  }
  return isManagedChildRunning(child);
}

function waitForManagedExit(child, timeoutMs, isRunning) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Process exit timeout must be a non-negative number");
  }
  if (!isRunning()) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (exited, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      child.removeListener?.("exit", handleExit);
      if (error) reject(error);
      else resolve(exited);
    };
    const handleExit = () => inspect();
    const inspect = () => {
      try {
        if (!isRunning()) finish(true);
      } catch (error) {
        finish(false, error);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const poller = setInterval(inspect, Math.min(50, Math.max(10, timeoutMs || 10)));
    child.once?.("exit", handleExit);
    inspect();
  });
}

export function waitForManagedChildExit(child, timeoutMs) {
  return waitForManagedExit(child, timeoutMs, () => isManagedChildRunning(child));
}

function waitForManagedProcessTreeExit(child, timeoutMs, options) {
  return waitForManagedExit(
    child,
    timeoutMs,
    () => isManagedProcessTreeRunning(child, options),
  );
}

function signalUnixProcessTree(child, signal, { detached, processKill }) {
  const pid = childPid(child);
  if (detached) {
    try {
      processKill(-pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function windowsTaskkillDescription(pid, env) {
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  if (typeof systemRoot !== "string" || !/^[a-z]:\\/i.test(systemRoot)) {
    throw new Error("SystemRoot is required for the Windows process-tree fallback");
  }
  return {
    command: path.win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
  };
}

function runWindowsTaskkill(
  pid,
  {
    env,
    spawnProcess,
    onFallback,
  },
) {
  const description = windowsTaskkillDescription(pid, env);
  onFallback({ ...description, pid });
  return new Promise((resolve, reject) => {
    const command = spawnProcess(description.command, description.args, {
      env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    command.once("error", reject);
    command.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function stopManagedChildGracefully(
  child,
  {
    detached = false,
    platform = process.platform,
    processKill = process.kill,
    requestGraceful,
    timeoutMs = 3_000,
  } = {},
) {
  const treeOptions = { detached, platform, processKill };
  if (!isManagedProcessTreeRunning(child, treeOptions)) {
    return PROCESS_STOP_RESULT.ALREADY_EXITED;
  }
  if (platform === "win32") {
    await requestGraceful?.(child);
  } else {
    signalUnixProcessTree(child, "SIGTERM", { detached, processKill });
  }
  return await waitForManagedProcessTreeExit(child, timeoutMs, treeOptions)
    ? PROCESS_STOP_RESULT.EXITED
    : PROCESS_STOP_RESULT.TIMED_OUT;
}

export async function forceStopManagedChildTree(
  child,
  {
    detached = false,
    platform = process.platform,
    processKill = process.kill,
    spawnProcess = defaultSpawn,
    env = process.env,
    onFallback = ({ pid }) => {
      console.error(`Windows process-tree force fallback: taskkill PID ${pid}`);
    },
    timeoutMs = 1_000,
  } = {},
) {
  const treeOptions = { detached, platform, processKill };
  if (!isManagedProcessTreeRunning(child, treeOptions)) {
    return PROCESS_STOP_RESULT.ALREADY_EXITED;
  }
  if (platform === "win32") {
    const outcome = await runWindowsTaskkill(childPid(child), {
      env,
      spawnProcess,
      onFallback,
    });
    const exited = await waitForManagedProcessTreeExit(child, timeoutMs, treeOptions);
    if (exited) return PROCESS_STOP_RESULT.EXITED;
    if (outcome.code !== 0) {
      throw new Error(`Windows process-tree fallback failed with exit code ${outcome.code}`);
    }
    return PROCESS_STOP_RESULT.TIMED_OUT;
  }
  signalUnixProcessTree(child, "SIGKILL", { detached, processKill });
  return await waitForManagedProcessTreeExit(child, timeoutMs, treeOptions)
    ? PROCESS_STOP_RESULT.EXITED
    : PROCESS_STOP_RESULT.TIMED_OUT;
}

export async function terminateManagedChildTree(
  child,
  {
    terminateTimeoutMs = 3_000,
    killTimeoutMs = 1_000,
    ...options
  } = {},
) {
  const graceful = await stopManagedChildGracefully(child, {
    ...options,
    timeoutMs: terminateTimeoutMs,
  });
  if (graceful !== PROCESS_STOP_RESULT.TIMED_OUT) return graceful;
  const forced = await forceStopManagedChildTree(child, {
    ...options,
    timeoutMs: killTimeoutMs,
  });
  if (forced === PROCESS_STOP_RESULT.TIMED_OUT) {
    throw new Error("Managed process tree did not exit after force stop");
  }
  return forced;
}
