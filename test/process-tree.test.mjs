import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PROCESS_STOP_RESULT,
  forceStopManagedChildTree,
  isProcessRunning,
  stopManagedChildGracefully,
  terminateManagedChildTree,
} from "../shared/process-tree.mjs";

const source = await readFile(new URL("../shared/process-tree.mjs", import.meta.url), "utf8");
const fixture = fileURLToPath(new URL("fixtures/process-tree-parent.mjs", import.meta.url));

function processExists(pid) {
  try {
    return isProcessRunning(pid);
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

async function firstJsonLine(stream) {
  stream.setEncoding("utf8");
  let content = "";
  for await (const chunk of stream) {
    content += chunk;
    const newline = content.indexOf("\n");
    if (newline >= 0) return JSON.parse(content.slice(0, newline));
  }
  throw new Error("Process-tree fixture exited before reporting its grandchild");
}

test("invalid PIDs cannot reach signals or taskkill arguments", async () => {
  let called = false;
  const child = Object.assign(new EventEmitter(), {
    pid: "1 & calc.exe",
    exitCode: null,
    signalCode: null,
    kill() { called = true; },
  });
  await assert.rejects(
    forceStopManagedChildTree(child, {
      platform: "win32",
      env: { SystemRoot: String.raw`C:\Windows` },
      processKill: () => { called = true; },
      spawnProcess: () => { called = true; },
    }),
    /positive 32-bit integer/,
  );
  assert.equal(called, false);
});

test("PID liveness distinguishes missing and permission-denied processes", () => {
  assert.equal(isProcessRunning(42, { processKill: () => {} }), true);
  assert.equal(isProcessRunning(42, {
    processKill: () => {
      const error = new Error("missing");
      error.code = "ESRCH";
      throw error;
    },
  }), false);
  assert.equal(isProcessRunning(42, {
    processKill: () => {
      const error = new Error("denied");
      error.code = "EPERM";
      throw error;
    },
  }), true);
});

test("Windows graceful stop uses an owner request before any taskkill fallback", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4320,
    exitCode: null,
    signalCode: null,
  });
  let requested = 0;
  assert.equal(
    await stopManagedChildGracefully(child, {
      platform: "win32",
      requestGraceful: async () => {
        requested += 1;
        child.exitCode = 0;
        child.emit("exit", 0, null);
      },
    }),
    PROCESS_STOP_RESULT.EXITED,
  );
  assert.equal(requested, 1);
});

test("Windows force fallback uses an absolute taskkill command without a shell", async () => {
  const target = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
  });
  const calls = [];
  const fallbacks = [];
  const result = await forceStopManagedChildTree(target, {
    platform: "win32",
    env: { SystemRoot: String.raw`C:\Windows Root` },
    processKill: () => {
      if (target.exitCode !== null) {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      }
    },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const taskkill = new EventEmitter();
      queueMicrotask(() => {
        target.exitCode = 1;
        target.emit("exit", 1, null);
        taskkill.emit("exit", 0, null);
      });
      return taskkill;
    },
    onFallback: (entry) => fallbacks.push(entry),
  });
  assert.equal(result, PROCESS_STOP_RESULT.EXITED);
  assert.deepEqual(calls[0].args, ["/PID", "4321", "/T", "/F"]);
  assert.equal(calls[0].command, String.raw`C:\Windows Root\System32\taskkill.exe`);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(fallbacks.length, 1);
});

test("negative PIDs are isolated to the Unix process-group helper", () => {
  const unixStart = source.indexOf("function signalUnixProcessTree");
  const windowsStart = source.indexOf("function windowsTaskkillDescription");
  assert.ok(unixStart >= 0 && windowsStart > unixStart);
  assert.match(source.slice(unixStart, windowsStart), /processKill\(-pid, signal\)/);
  assert.doesNotMatch(source.slice(windowsStart), /processKill\(-pid/);
  assert.match(source, /shell: false/);
});

test("graceful stop reports an already exited child without signaling", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(child, "exit");
  assert.equal(
    await stopManagedChildGracefully(child),
    PROCESS_STOP_RESULT.ALREADY_EXITED,
  );
});

test("real detached child and grandchild are both removed after bounded force stop", async () => {
  const child = spawn(process.execPath, [fixture], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const { grandchildPid } = await firstJsonLine(child.stdout);
  try {
    assert.equal(processExists(child.pid), true);
    assert.equal(processExists(grandchildPid), true);
    assert.equal(
      await terminateManagedChildTree(child, {
        detached: true,
        terminateTimeoutMs: 100,
        killTimeoutMs: 2_000,
      }),
      PROCESS_STOP_RESULT.EXITED,
    );
    assert.equal(await waitForProcessExit(child.pid), true);
    assert.equal(await waitForProcessExit(grandchildPid), true);
  } finally {
    if (processExists(child.pid)) {
      await forceStopManagedChildTree(child, { detached: true, timeoutMs: 2_000 }).catch(() => {});
    }
  }
});
