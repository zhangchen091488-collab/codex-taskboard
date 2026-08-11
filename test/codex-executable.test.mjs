import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveCodexExecutable } from "../shared/codex-executable.mjs";

test("explicit Codex executable remains authoritative", () => {
  const explicit = String.raw` C:\Program Files\Codex CLI\codex.cmd `;
  const result = resolveCodexExecutable({
    explicit,
    env: { PATH: String.raw`C:\another` },
    platform: "win32",
    isExecutable: () => {
      throw new Error("PATH lookup must not run for an explicit executable");
    },
  });

  assert.equal(result, String.raw`C:\Program Files\Codex CLI\codex.cmd`);
});

test("Windows PATH lookup honors directory and PATHEXT order", () => {
  const executable = String.raw`C:\Program Files\Codex CLI\codex.EXE`;
  const checked = [];
  const result = resolveCodexExecutable({
    explicit: "",
    env: {
      PATH: String.raw`;C:\missing;"C:\Program Files\Codex CLI";C:\用户 tools`,
      PATHEXT: ".CMD;EXE;.cmd;invalid/extension",
    },
    platform: "win32",
    isExecutable(candidate) {
      checked.push(candidate);
      return candidate.toLowerCase() === executable.toLowerCase();
    },
  });

  assert.equal(result, executable);
  assert.deepEqual(checked, [
    String.raw`C:\missing\codex.CMD`,
    String.raw`C:\missing\codex.EXE`,
    String.raw`C:\Program Files\Codex CLI\codex.CMD`,
    executable,
  ]);
});

test("Windows PATH lookup falls back to the standard PATHEXT", () => {
  const executable = String.raw`C:\tools\codex.cmd`;
  const result = resolveCodexExecutable({
    explicit: null,
    env: { PATH: String.raw`C:\tools` },
    platform: "win32",
    isExecutable: (candidate) => candidate.toLowerCase() === executable.toLowerCase(),
  });

  assert.equal(result.toLowerCase(), executable.toLowerCase());
});

test("POSIX PATH lookup skips empty and non-executable candidates", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex executable-中文-"));
  const first = path.join(root, "not executable");
  const second = path.join(root, "可执行 tools");
  try {
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, "codex"), "not executable\n");
    await writeFile(path.join(second, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(second, "codex"), 0o755);

    assert.equal(
      resolveCodexExecutable({
        explicit: "",
        env: { PATH: ["", first, second].join(path.delimiter) },
        platform: process.platform,
        homeDirectory: path.join(root, "empty home"),
      }),
      path.join(second, "codex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows PATH lookup accepts a real cmd file", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex executable-中文-"));
  try {
    const executable = path.join(root, "codex.cmd");
    await writeFile(executable, "@echo off\r\nexit /b 0\r\n");

    assert.equal(resolveCodexExecutable({
      explicit: "",
      env: { PATH: root, PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      homeDirectory: path.join(root, "empty home"),
    }), executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop App discovery stays macOS-only", () => {
  const appPath = "/Applications/Codex.app";
  const bundled = path.join(appPath, "Contents", "Resources", "codex");

  assert.equal(resolveCodexExecutable({
    explicit: "",
    appPath,
    env: { PATH: "" },
    platform: "darwin",
    isExecutable: (candidate) => candidate === bundled,
  }), bundled);
  assert.equal(resolveCodexExecutable({
    explicit: "",
    appPath,
    env: { PATH: "" },
    platform: "win32",
    isExecutable: () => true,
  }), "codex");
});
