import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ProjectSummaryService } from "../server/project-summary.mjs";
import {
  forceStopManagedChildTree,
  isProcessRunning,
} from "../shared/process-tree.mjs";

const stubbornTreePath = fileURLToPath(
  new URL("fixtures/process-tree-parent.mjs", import.meta.url),
);

function createDatabase() {
  const summary = {
    projectId: "project",
    summary: null,
    generatedAt: null,
    attemptedAt: null,
    error: null,
  };
  return {
    getProject: (projectId) => projectId === "project"
      ? { id: "project", name: "Project" }
      : null,
    getProjectSummary: () => ({ ...summary }),
    listProjectSummaries: () => [],
    listTasks: () => [],
    saveProjectSummary(projectId, value) {
      summary.projectId = projectId;
      summary.summary = value;
      summary.generatedAt = new Date().toISOString();
      summary.attemptedAt = summary.generatedAt;
      summary.error = null;
    },
    saveProjectSummaryError(projectId, error) {
      summary.projectId = projectId;
      summary.attemptedAt = new Date().toISOString();
      summary.error = error;
    },
  };
}

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
  throw new Error("Timed out waiting for project summary state");
}

test("project summary keeps the successful Codex result unchanged", async () => {
  const database = createDatabase();
  const service = new ProjectSummaryService({
    database,
    codexExecutable: "codex",
    workspacePath: "/workspace",
    spawnTurn({ onRawEvent }) {
      onRawEvent({
        type: "item.completed",
        item: { type: "agent_message", text: "  项目进展正常。  " },
      });
      const child = Object.assign(new EventEmitter(), {
        pid: 4323,
        exitCode: 0,
        signalCode: null,
      });
      return {
        child,
        completion: Promise.resolve({ exitCode: 0, signal: null }),
      };
    },
  });
  try {
    service.get("project");
    const result = await waitFor(() => database.getProjectSummary("project").summary);
    assert.equal(result, "项目进展正常。");
  } finally {
    await service.close();
  }
});

test("project summary close removes a SIGTERM-resistant child tree", async () => {
  const database = createDatabase();
  let child;
  let grandchildPromise;
  const service = new ProjectSummaryService({
    database,
    codexExecutable: "codex",
    workspacePath: "/workspace",
    killGraceMs: 50,
    spawnTurn() {
      child = spawn(process.execPath, [stubbornTreePath], {
        detached: true,
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      });
      grandchildPromise = new Promise((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.once("data", (chunk) => {
          try {
            resolve(JSON.parse(chunk.trim()).grandchildPid);
          } catch (error) {
            reject(error);
          }
        });
      });
      return {
        child,
        completion: once(child, "close").then(([exitCode, signal]) => ({ exitCode, signal })),
      };
    },
  });
  let resolvedGrandchildPid;
  try {
    service.get("project");
    resolvedGrandchildPid = await waitFor(() => grandchildPromise);
    assert.equal(processExists(child.pid), true);
    assert.equal(processExists(resolvedGrandchildPid), true);

    await service.close();

    assert.equal(processExists(child.pid), false);
    assert.equal(processExists(resolvedGrandchildPid), false);
  } finally {
    await service.close().catch(() => {});
    if (child && processExists(child.pid)) {
      await forceStopManagedChildTree(child, {
        detached: true,
        timeoutMs: 2_000,
      }).catch(() => {});
    }
  }
});
