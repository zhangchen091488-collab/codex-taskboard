import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  forceStopManagedChildTree,
  isProcessRunning,
} from "../shared/process-tree.mjs";

const ownerPath = fileURLToPath(new URL("../server/ai-turn-owner.mjs", import.meta.url));
const childPath = fileURLToPath(new URL("fixtures/ai-turn-owner-child.mjs", import.meta.url));

function processExists(pid) {
  try {
    return isProcessRunning(pid);
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for AI turn-owner state");
}

test("turn owner removes its stubborn child tree when the parent control pipe disconnects", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-turn-owner-"));
  const statePath = path.join(directory, "state.json");
  const owner = spawn(process.execPath, [
    ownerPath,
    process.execPath,
    JSON.stringify([childPath, statePath]),
  ], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit", "pipe"],
    windowsHide: true,
  });
  let state;
  try {
    state = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(statePath, "utf8"));
      } catch {
        return null;
      }
    });
    assert.equal(processExists(state.childPid), true);
    assert.equal(processExists(state.descendantPid), true);
    owner.stdio[3].destroy();
    await waitFor(() => !processExists(owner.pid));
    await waitFor(() => !processExists(state.childPid));
    await waitFor(() => !processExists(state.descendantPid));
  } finally {
    owner.stdio[3].destroy();
    if (processExists(owner.pid)) {
      await forceStopManagedChildTree(owner, {
        detached: true,
        timeoutMs: 2_000,
      }).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
});
