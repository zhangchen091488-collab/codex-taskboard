import { createTaskboardReadinessTracker } from "../shared/taskboard-readiness.mjs";
import {
  isManagedChildRunning,
  terminateManagedChildTree,
} from "../shared/process-tree.mjs";

const isRunning = isManagedChildRunning;
const TASKBOARD_SHUTDOWN_MESSAGE = Object.freeze({
  type: "codex-taskboard:shutdown",
  version: 1,
});

function requestGracefulTaskboardShutdown(child) {
  if (!child?.connected || typeof child.send !== "function") return;
  return new Promise((resolve) => {
    child.send(TASKBOARD_SHUTDOWN_MESSAGE, () => resolve());
  });
}

export function taskboardChildStdio({ detached }) {
  const standardIo = detached ? "ignore" : "inherit";
  return [standardIo, standardIo, standardIo, "ipc"];
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

export async function terminateManagedChild(
  child,
  options = {},
) {
  return terminateManagedChildTree(child, {
    requestGraceful: requestGracefulTaskboardShutdown,
    ...options,
  });
}

export function createTaskboardSupervisor({
  detached,
  platform = process.platform,
  isReachable,
  waitUntilReachable,
  waitForReadiness = waitForTaskboardReadiness,
  onReadiness = () => {},
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
        await terminateManagedChild(managedChild, { detached, platform });
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
        await onReadiness(readiness);
        await waitUntilReachable(10_000);
        retryAfter = 0;
        return { status: "ok", restarted: true, readiness };
      } catch (error) {
        await terminateManagedChild(started, { detached, platform }).catch(() => {});
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
    await terminateManagedChild(managedChild, { detached, platform });
    if (child === managedChild) child = null;
  }

  return { ensure, stop };
}
