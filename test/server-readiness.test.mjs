import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";

import {
  createTaskboardSupervisor,
  waitForTaskboardReadiness,
} from "../scripts/taskboard-supervisor.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(projectRoot, "server", "index.mjs");
const instanceToken = "readiness-test-0000000000000001";
const instanceSecret = "0123456789abcdef0123456789abcdef";

function capture(stream) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
  });
  return () => output;
}

function startServer(dataDirectory, port) {
  return fork(serverPath, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_TASKBOARD_DATA_DIR: dataDirectory,
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: String(port),
      CODEX_TASKBOARD_INSTANCE_TOKEN: instanceToken,
      CODEX_TASKBOARD_INSTANCE_SECRET: instanceSecret,
      CODEX_TASKBOARD_LAUNCHER_READINESS: "1",
    },
    silent: true,
  });
}

async function waitForOutput(stream, readOutput, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(readOutput())) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for output matching ${pattern}`);
    await Promise.race([
      once(stream, "data"),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Timed out waiting for output matching ${pattern}`)),
        remaining,
      )),
    ]);
  }
}

async function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Timed out waiting for child process exit")),
      timeoutMs,
    )),
  ]);
}

async function connectToLoopback(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    await once(socket, "connect");
  } finally {
    socket.destroy();
  }
}

test("server reports its actual port over IPC only after listening", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-readiness-"));
  const child = startServer(directory, 0);
  const readStdout = capture(child.stdout);
  const readStderr = capture(child.stderr);
  try {
    const readiness = await waitForTaskboardReadiness(child, 5_000);
    assert.equal(readiness.status, "listening");
    assert.equal(readiness.host, "127.0.0.1");
    assert.ok(Number.isInteger(readiness.port) && readiness.port > 0);
    await connectToLoopback(readiness.port);
    await waitForOutput(
      child.stdout,
      readStdout,
      new RegExp(`Codex Taskboard listening on http://127\\.0\\.0\\.1:${readiness.port}`),
    );

    const protocol = JSON.stringify(readiness);
    assert.doesNotMatch(readStdout(), /codex-taskboard:readiness/);
    assert.doesNotMatch(readStderr(), /codex-taskboard:readiness/);
    for (const sensitiveValue of [instanceToken, instanceSecret]) {
      assert.ok(!protocol.includes(sensitiveValue));
      assert.ok(!readStdout().includes(sensitiveValue));
      assert.ok(!readStderr().includes(sensitiveValue));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher IPC performs a versioned graceful server shutdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-readiness-shutdown-"));
  const child = startServer(directory, 0);
  capture(child.stdout);
  capture(child.stderr);
  try {
    const readiness = await waitForTaskboardReadiness(child, 5_000);
    child.send({ type: "codex-taskboard:shutdown", version: 2 });
    await connectToLoopback(readiness.port);
    child.send({ type: "codex-taskboard:shutdown", version: 1 });
    await waitForExit(child);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("server sends a generic error readiness message when listening fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-readiness-error-"));
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = blocker.address().port;
  const child = startServer(directory, port);
  const readStdout = capture(child.stdout);
  const readStderr = capture(child.stderr);
  try {
    await assert.rejects(
      waitForTaskboardReadiness(child, 5_000),
      /Taskboard startup failed: LISTEN_FAILED/,
    );
    await waitForExit(child);
    assert.equal(child.exitCode, 1);
    assert.equal(readStdout(), "");
    assert.match(readStderr(), /EADDRINUSE/);
    assert.doesNotMatch(readStderr(), /codex-taskboard:readiness/);
    for (const sensitiveValue of [instanceToken, instanceSecret]) {
      assert.ok(!readStderr().includes(sensitiveValue));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child);
    await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent launcher servers receive unique OS-assigned loopback ports", async () => {
  const directories = await Promise.all(Array.from(
    { length: 8 },
    () => mkdtemp(path.join(os.tmpdir(), "taskboard-readiness-stress-")),
  ));
  const children = directories.map((directory) => startServer(directory, 0));
  for (const child of children) {
    capture(child.stdout);
    capture(child.stderr);
  }
  try {
    const readinessMessages = await Promise.all(
      children.map((child) => waitForTaskboardReadiness(child, 10_000)),
    );
    const ports = readinessMessages.map((message) => message.port);
    assert.equal(new Set(ports).size, children.length);
    assert.ok(readinessMessages.every((message) => (
      message.host === "127.0.0.1" && message.port > 0
    )));
    await Promise.all(ports.map(connectToLoopback));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await Promise.all(children.map((child) => waitForExit(child)));
    await Promise.all(directories.map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  }
});

test("supervisor applies the random port before its health gate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-readiness-supervisor-"));
  let currentPort = 0;
  let child;
  const supervisor = createTaskboardSupervisor({
    detached: false,
    isReachable: async () => false,
    onReadiness: (readiness) => {
      currentPort = readiness.port;
    },
    waitUntilReachable: async () => {
      assert.ok(currentPort > 0);
      await connectToLoopback(currentPort);
    },
    start: () => {
      child = startServer(directory, 0);
      capture(child.stdout);
      capture(child.stderr);
      return child;
    },
  });
  try {
    const result = await supervisor.ensure({ force: true });
    assert.equal(result.status, "ok");
    assert.equal(result.restarted, true);
    assert.equal(result.readiness.port, currentPort);
  } finally {
    await supervisor.stop();
    if (child) await waitForExit(child);
    await rm(directory, { recursive: true, force: true });
  }
});
