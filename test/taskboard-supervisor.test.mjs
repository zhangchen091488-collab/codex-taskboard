import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createTaskboardSupervisor,
  taskboardChildStdio,
  waitForTaskboardReadiness,
} from "../scripts/taskboard-supervisor.mjs";
import {
  createTaskboardReadinessTracker,
  errorReadiness,
  formatLauncherReadinessLine,
  listeningReadiness,
  parseTaskboardReadiness,
} from "../shared/taskboard-readiness.mjs";

class ManagedChild extends EventEmitter {
  constructor(name, events) {
    super();
    this.name = name;
    this.events = events;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal) {
    this.events.push(["kill", this.name, signal]);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  unref() {}
}

test("Taskboard child stdio reserves a dedicated IPC channel", () => {
  assert.deepEqual(taskboardChildStdio({ detached: false, listenFd: null }), [
    "inherit", "inherit", "inherit", "ipc",
  ]);
  assert.deepEqual(taskboardChildStdio({ detached: true, listenFd: null }), [
    "ignore", "ignore", "ignore", "ipc",
  ]);
  assert.deepEqual(taskboardChildStdio({ detached: false, listenFd: 5 }), [
    "inherit", "inherit", "inherit", "ignore", "ignore", "inherit", "ipc",
  ]);
});

test("an unhealthy live child exits before its replacement starts", async () => {
  const events = [];
  let sequence = 0;
  const supervisor = createTaskboardSupervisor({
    detached: false,
    isReachable: async () => false,
    waitUntilReachable: async (timeoutMs) => {
      events.push(["health", timeoutMs]);
      if (timeoutMs === 3_000) throw new Error("unhealthy");
    },
    waitForReadiness: async (child, timeoutMs) => {
      events.push(["readiness", child.name, timeoutMs]);
      return listeningReadiness(47823);
    },
    onReadiness: async (readiness) => {
      events.push(["endpoint", readiness.port]);
    },
    start: () => {
      const child = new ManagedChild(`child-${++sequence}`, events);
      events.push(["start", child.name]);
      return child;
    },
  });

  await supervisor.ensure();
  await supervisor.ensure({ force: true });

  assert.deepEqual(events.slice(0, 10), [
    ["start", "child-1"],
    ["readiness", "child-1", 10_000],
    ["endpoint", 47823],
    ["health", 10_000],
    ["health", 3_000],
    ["kill", "child-1", "SIGTERM"],
    ["start", "child-2"],
    ["readiness", "child-2", 10_000],
    ["endpoint", 47823],
    ["health", 10_000],
  ]);
  await supervisor.stop();
});

test("readiness schema accepts only versioned loopback terminal messages", () => {
  assert.deepEqual(parseTaskboardReadiness(listeningReadiness(49152)), {
    type: "codex-taskboard:readiness",
    version: 1,
    status: "listening",
    host: "127.0.0.1",
    port: 49152,
  });
  assert.deepEqual(parseTaskboardReadiness(errorReadiness()), {
    type: "codex-taskboard:readiness",
    version: 1,
    status: "error",
    code: "LISTEN_FAILED",
  });
  for (const message of [
    null,
    { ...listeningReadiness(49152), version: 2 },
    { ...listeningReadiness(49152), host: "0.0.0.0" },
    { ...listeningReadiness(49152), port: 0 },
    { ...listeningReadiness(49152), secret: "must-not-be-accepted" },
    { ...errorReadiness(), code: "RAW_ERROR" },
  ]) {
    assert.throws(() => parseTaskboardReadiness(message), /Taskboard readiness|readiness message/);
  }
});

test("launcher readiness framing has one fixed prefix and compact JSON payload", () => {
  assert.equal(
    formatLauncherReadinessLine(listeningReadiness(49152)),
    "CODEX_TASKBOARD_READINESS_V1 "
      + '{"type":"codex-taskboard:readiness","version":1,"status":"listening",'
      + '"host":"127.0.0.1","port":49152}',
  );
  assert.equal(
    formatLauncherReadinessLine(errorReadiness()),
    "CODEX_TASKBOARD_READINESS_V1 "
      + '{"type":"codex-taskboard:readiness","version":1,"status":"error",'
      + '"code":"LISTEN_FAILED"}',
  );
});

test("readiness tracker rejects duplicate and timeout states", () => {
  const duplicate = createTaskboardReadinessTracker();
  duplicate.accept(listeningReadiness(49152));
  assert.throws(
    () => duplicate.accept(listeningReadiness(49152)),
    /sent more than once/,
  );
  assert.throws(
    () => createTaskboardReadinessTracker().timeout(),
    /Timed out waiting for Taskboard readiness/,
  );
});

test("supervisor readiness receiver rejects malformed, duplicate, error, and timeout messages", async () => {
  const malformed = new ManagedChild("malformed", []);
  const malformedResult = waitForTaskboardReadiness(malformed, 100);
  malformed.emit("message", { type: "not-readiness" });
  await assert.rejects(malformedResult, /unsupported type or version/);

  const duplicate = new ManagedChild("duplicate", []);
  const duplicateResult = waitForTaskboardReadiness(duplicate, 100);
  duplicate.emit("message", listeningReadiness(49152));
  duplicate.emit("message", listeningReadiness(49152));
  await assert.rejects(duplicateResult, /sent more than once/);

  const failed = new ManagedChild("failed", []);
  const failedResult = waitForTaskboardReadiness(failed, 100);
  failed.emit("message", errorReadiness());
  await assert.rejects(failedResult, /LISTEN_FAILED/);

  const timedOut = new ManagedChild("timeout", []);
  await assert.rejects(waitForTaskboardReadiness(timedOut, 5), /Timed out/);
});
