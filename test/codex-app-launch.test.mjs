import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  codexAppExecutablePath,
  codexIndependentLaunchArguments,
  launchCodexAppWithPrivatePipe,
  launchIndependentCodexApp,
} from "../shared/codex-app-launch.mjs";

test("Windows Codex launch keeps executable and Unicode profile paths as separate values", () => {
  const executable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe`;
  const profile = String.raw`C:\Users\示例 User\AppData\Roaming\com.taskboard\codex-profile`;
  const calls = [];

  const child = launchIndependentCodexApp({
    appPath: executable,
    profilePath: profile,
    platform: "win32",
    environment: {
      PATH: String.raw`C:\Windows\System32`,
      CODEX_TASKBOARD_INSTANCE_TOKEN: "must-not-reach-codex",
      CODEX_TASKBOARD_INSTANCE_SECRET: "must-not-reach-codex",
      codex_taskboard_lowercase_secret: "must-also-not-reach-codex",
    },
    spawnProcess(...args) {
      calls.push(args);
      return { pid: 42 };
    },
  });

  assert.deepEqual(child, { pid: 42 });
  assert.deepEqual(calls, [[
    executable,
    [`--user-data-dir=${profile}`],
    {
      env: {
        PATH: String.raw`C:\Windows\System32`,
        CODEX_ELECTRON_USER_DATA_PATH: profile,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  ]]);
});

test("launch-only arguments contain no CDP transport or shell command", () => {
  const arguments_ = codexIndependentLaunchArguments(String.raw`C:\profile with spaces`);

  assert.deepEqual(arguments_, [String.raw`--user-data-dir=C:\profile with spaces`]);
  assert.doesNotMatch(arguments_.join(" "), /remote-debugging|cdp|cmd\.exe|powershell/i);
});

test("private-pipe launch exposes only inherited CDP descriptors and no debug port", () => {
  const executable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe`;
  const profile = String.raw`C:\Users\示例 User\AppData\Roaming\com.taskboard\codex profile`;
  const calls = [];
  launchCodexAppWithPrivatePipe({
    appPath: executable,
    profilePath: profile,
    platform: "win32",
    environment: {
      PATH: String.raw`C:\Windows\System32`,
      CODEX_TASKBOARD_INSTANCE_SECRET: "must-not-reach-codex",
    },
    spawnProcess(...args) {
      calls.push(args);
      return { pid: 53 };
    },
  });

  assert.deepEqual(calls, [[
    executable,
    [`--user-data-dir=${profile}`, "--remote-debugging-pipe"],
    {
      env: {
        PATH: String.raw`C:\Windows\System32`,
        CODEX_ELECTRON_USER_DATA_PATH: profile,
      },
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  ]]);
  assert.doesNotMatch(JSON.stringify(calls), /remote-debugging-port|127\.0\.0\.1|0\.0\.0\.0/);
});

test("macOS executable resolution retains the existing application-bundle behavior", () => {
  assert.equal(
    codexAppExecutablePath("/Applications/ChatGPT.app", { platform: "darwin" }),
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  );
});

test("launch-only failure releases the profile lease and exits with a recoverable error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex launch-only-示例 "));
  const profile = path.join(root, "independent profile");
  try {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../scripts/codex-injector.mjs", import.meta.url)),
      "--launch-only",
      "--app-path",
      path.join(root, "missing ChatGPT app"),
      "--profile-path",
      profile,
      "--source-profile-path",
      path.join(root, "official profile"),
    ], {
      env: {
        ...process.env,
        CODEX_TASKBOARD_INSTANCE_SECRET: "must-not-appear-in-launch-error",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    assert.equal(exit.code, 1);
    assert.equal(exit.signal, null);
    assert.doesNotMatch(stderr, /must-not-appear-in-launch-error/);
    await assert.rejects(
      stat(path.join(profile, ".codex-taskboard-profile.lock")),
      (error) => error?.code === "ENOENT",
    );
    assert.equal(
      (await stat(path.join(profile, ".codex-taskboard-independent-profile-v1"))).isFile(),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch-only starts one isolated app with only the profile argument", {
  skip: process.platform === "win32"
    ? "Windows executable launch is covered by native suspended-launch and Job Object tests"
    : false,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex launch success-示例 "));
  const appPath = path.join(root, "Fake ChatGPT.app");
  const executable = path.join(appPath, "Contents", "MacOS", "Fake ChatGPT");
  const outputPath = path.join(root, "child output.json");
  const profile = path.join(root, "independent profile");
  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, `#!${process.execPath}
import { writeFile } from "node:fs/promises";
await writeFile(process.env.CODEX_LAUNCH_FIXTURE_OUTPUT, JSON.stringify({
  arguments: process.argv.slice(2),
  userDataOverride: process.env.CODEX_ELECTRON_USER_DATA_PATH,
  leakedTaskboardNames: Object.keys(process.env).filter((name) => name.startsWith("CODEX_TASKBOARD_")),
}));
`);
    await chmod(executable, 0o755);
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../scripts/codex-injector.mjs", import.meta.url)),
      "--launch-only",
      "--app-path",
      appPath,
      "--profile-path",
      profile,
      "--source-profile-path",
      path.join(root, "official profile"),
    ], {
      env: {
        ...process.env,
        CODEX_LAUNCH_FIXTURE_OUTPUT: outputPath,
        CODEX_TASKBOARD_INSTANCE_SECRET: "must-not-reach-child",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));

    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      arguments: [`--user-data-dir=${profile}`],
      userDataOverride: profile,
      leakedTaskboardNames: [],
    });
    await assert.rejects(
      stat(path.join(profile, ".codex-taskboard-profile.lock")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
