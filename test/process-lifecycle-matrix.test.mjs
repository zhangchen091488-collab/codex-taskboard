import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CODEX_PROCESS_DISPOSITION,
  codexProcessDisposition,
} from "../scripts/codex-injector-runtime.mjs";
import {
  forceStopManagedChildTree,
  isProcessRunning,
  terminateManagedChildTree,
} from "../shared/process-tree.mjs";

const stubbornTreePath = fileURLToPath(
  new URL("fixtures/process-tree-parent.mjs", import.meta.url),
);
const orphanTreePath = fileURLToPath(
  new URL("fixtures/process-tree-orphan.mjs", import.meta.url),
);

function processExists(pid) {
  try {
    return isProcessRunning(pid);
  } catch {
    return false;
  }
}

async function firstJsonLine(stream) {
  stream.setEncoding("utf8");
  let content = "";
  for await (const chunk of stream) {
    content += chunk;
    const newline = content.indexOf("\n");
    if (newline >= 0) return JSON.parse(content.slice(0, newline));
  }
  throw new Error("Lifecycle fixture exited before reporting its process tree");
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processExists(pid);
}

test("launcher stop removes every process across two forced-shutdown attempts", async (t) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const launcher = spawn(process.execPath, [stubbornTreePath], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    let grandchildPid;
    try {
      ({ grandchildPid } = await firstJsonLine(launcher.stdout));
      const before = {
        attempt,
        rootPid: launcher.pid,
        descendantPid: grandchildPid,
        rootRunning: processExists(launcher.pid),
        descendantRunning: processExists(grandchildPid),
      };
      assert.equal(before.rootRunning, true);
      assert.equal(before.descendantRunning, true);

      await terminateManagedChildTree(launcher, {
        detached: true,
        terminateTimeoutMs: 50,
        killTimeoutMs: 2_000,
      });
      const after = {
        rootRunning: processExists(launcher.pid),
        descendantRunning: processExists(grandchildPid),
      };
      t.diagnostic(JSON.stringify({ scenario: "launcher-stop", before, after }));
      assert.deepEqual(after, { rootRunning: false, descendantRunning: false });
    } finally {
      if (processExists(launcher.pid) || processExists(grandchildPid)) {
        await forceStopManagedChildTree(launcher, {
          detached: true,
          timeoutMs: 2_000,
        }).catch(() => {});
      }
    }
  }
});

test("a crashed Unix tree leader does not hide its orphan before recovery", {
  skip: process.platform === "win32"
    ? "Windows orphan cleanup is owned by the launcher Job Object integration tests"
    : false,
}, async (t) => {
  const launcher = spawn(process.execPath, [orphanTreePath], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let descendantPid;
  try {
    ({ descendantPid } = await firstJsonLine(launcher.stdout));
    if (launcher.exitCode === null && launcher.signalCode === null) {
      await once(launcher, "exit");
    }
    assert.equal(launcher.exitCode, 7);
    assert.equal(processExists(descendantPid), true);

    await terminateManagedChildTree(launcher, {
      detached: true,
      terminateTimeoutMs: 50,
      killTimeoutMs: 2_000,
    });
    assert.equal(await waitForExit(descendantPid), true);
    t.diagnostic(JSON.stringify({
      scenario: "node-crash",
      rootPid: launcher.pid,
      rootExitCode: launcher.exitCode,
      descendantPid,
      orphanRunningAfterCleanup: processExists(descendantPid),
    }));
  } finally {
    if (processExists(launcher.pid) || processExists(descendantPid)) {
      await forceStopManagedChildTree(launcher, {
        detached: true,
        timeoutMs: 2_000,
      }).catch(() => {});
    }
  }
});

test("Codex normal exit idles while crash and signal exits request recovery", async (t) => {
  const scenarios = [
    { name: "normal", args: ["-e", "process.exit(0)"], expected: "idle" },
    { name: "crash", args: ["-e", "process.exit(7)"], expected: "restart" },
    {
      name: "signal",
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      expected: "restart",
    },
  ];
  for (const scenario of scenarios) {
    const codex = spawn(process.execPath, scenario.args, { stdio: "ignore" });
    assert.equal(
      codexProcessDisposition(codex),
      CODEX_PROCESS_DISPOSITION.RUNNING,
    );
    await once(codex, "exit");
    const disposition = codexProcessDisposition(codex);
    t.diagnostic(JSON.stringify({
      scenario: `codex-${scenario.name}`,
      pid: codex.pid,
      exitCode: codex.exitCode,
      signalCode: codex.signalCode,
      disposition,
    }));
    assert.equal(disposition, scenario.expected);
  }
});
