import { createTaskboardReadinessTracker } from "../shared/taskboard-readiness.mjs";

function isRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

export function taskboardChildStdio({ detached, listenFd }) {
  const standardIo = detached ? "ignore" : "inherit";
  if (listenFd === null) return [standardIo, standardIo, standardIo, "ipc"];
  return Array.from({ length: listenFd + 2 }, (_, fd) => {
    if (fd === listenFd) return "inherit";
    if (fd === listenFd + 1) return "ipc";
    return fd < 3 ? standardIo : "ignore";
  });
}

export function waitForTaskboardReadiness(child, timeoutMs) {
  const tracker = createTaskboardReadinessTracker();
  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingMessage = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", handleMessage);
      child.removeListener("error", handleError);
      child.removeListener("exit", handleExit);
      if (error) reject(error);
      else resolve(value);
    };
    const settleMessage = () => {
      if (!pendingMessage || settled) return;
      if (pendingMessage.status === "error") {
        finish(new Error(`Taskboard startup failed: ${pendingMessage.code}`));
      } else {
        finish(null, pendingMessage);
      }
    };
    const handleMessage = (message) => {
      try {
        pendingMessage = tracker.accept(message);
        queueMicrotask(settleMessage);
      } catch (error) {
        finish(error);
      }
    };
    const handleError = (error) => finish(error);
    const handleExit = (code, signal) => finish(
      new Error(`Taskboard exited before readiness (${signal || code})`),
    );
    const timer = setTimeout(() => {
      try {
        tracker.timeout();
      } catch (error) {
        finish(error);
      }
    }, timeoutMs);
    child.on("message", handleMessage);
    child.once("error", handleError);
    child.once("exit", handleExit);
  });
}

function waitForExit(child, timeoutMs) {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", handleExit);
      resolve(exited);
    };
    const handleExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", handleExit);
    if (!isRunning(child)) finish(true);
  });
}

export async function terminateManagedChild(
  child,
  { terminateTimeoutMs = 3_000, killTimeoutMs = 1_000 } = {},
) {
  if (!isRunning(child)) return;
  const terminated = waitForExit(child, terminateTimeoutMs);
  child.kill("SIGTERM");
  if (await terminated) return;

  if (isRunning(child)) child.kill("SIGKILL");
  if (!(await waitForExit(child, killTimeoutMs)) && isRunning(child)) {
    throw new Error("Taskboard process did not exit after SIGKILL");
  }
}

export function createTaskboardSupervisor({
  detached,
  isReachable,
  waitUntilReachable,
  waitForReadiness = waitForTaskboardReadiness,
  start,
  onProcessError = () => {},
  onUnexpectedExit = () => {},
}) {
  let child = null;
  let ensureInFlight = null;
  let retryAfter = 0;
  let stopping = false;

  async function ensure({ force = false } = {}) {
    const reachable = await isReachable();
    if (stopping) throw new Error("Taskboard supervisor is stopping");
    if (reachable) return { status: "ok", restarted: false };
    if (ensureInFlight) return ensureInFlight;
    if (!force && Date.now() < retryAfter) {
      throw new Error("Taskboard restart is waiting before its next attempt");
    }

    ensureInFlight = (async () => {
      const managedChild = child;
      if (isRunning(managedChild)) {
        try {
          await waitUntilReachable(3_000);
          return { status: "ok", restarted: false };
        } catch (_) {}
        await terminateManagedChild(managedChild);
        if (child === managedChild) child = null;
      }

      if (stopping) throw new Error("Taskboard supervisor is stopping");
      const started = start();
      child = started;
      if (detached) started.unref();
      started.once("error", (error) => {
        if (!stopping) onProcessError(error);
      });
      started.once("exit", (code, signal) => {
        if (child === started) child = null;
        if (!stopping && !detached && code !== 0) onUnexpectedExit(code, signal);
      });

      try {
        const readiness = await waitForReadiness(started, 10_000);
        await waitUntilReachable(10_000);
        retryAfter = 0;
        return { status: "ok", restarted: true, readiness };
      } catch (error) {
        await terminateManagedChild(started).catch(() => {});
        if (child === started) child = null;
        retryAfter = Date.now() + 2_000;
        throw error;
      }
    })();

    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = null;
    }
  }

  async function stop() {
    stopping = true;
    const managedChild = child;
    await terminateManagedChild(managedChild);
    if (child === managedChild) child = null;
  }

  return { ensure, stop };
}
