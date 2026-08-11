import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { runCodexTransportOnly } from "../scripts/codex-transport-only.mjs";

const nonce = "00000000-0000-4000-8000-000000000053";

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    child.emit("exit", null, signal);
    return true;
  };
  child.finish = (code) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  return child;
}

function fixture({ open, onPublish } = {}) {
  const calls = [];
  const child = fakeChild();
  let released = 0;
  const dependencies = {
    async initializeIndependentCodexProfile(options) {
      calls.push(["initialize", options]);
    },
    async acquireCodexProfileLease(profilePath) {
      calls.push(["lease", profilePath]);
      return {
        async release() {
          released += 1;
        },
      };
    },
    launchCodexAppWithPrivatePipe(options) {
      calls.push(["launch", options]);
      return child;
    },
    createBrowser(candidate) {
      assert.equal(candidate, child);
      return {
        async open() {
          calls.push(["open"]);
          await open?.(child);
        },
        close() {
          calls.push(["close"]);
        },
      };
    },
    async publishCodexTransportReadiness(filePath, message) {
      calls.push(["publish", filePath, message]);
      await onPublish?.(message, child);
    },
  };
  return {
    calls,
    child,
    dependencies,
    get released() {
      return released;
    },
  };
}

function run(testFixture) {
  return runCodexTransportOnly({
    appPath: String.raw`C:\Program Files\OpenAI\ChatGPT.exe`,
    profilePath: String.raw`C:\Users\示例 User\Codex profile`,
    sourceProfilePath: String.raw`C:\Users\示例 User\Codex`,
    readinessFile: String.raw`C:\Users\示例 User\ready 53.json`,
    readinessNonce: nonce,
    dependencies: testFixture.dependencies,
  });
}

test("transport-only performs one handshake, publishes ready, and never reconnects", async () => {
  const testFixture = fixture({
    onPublish(message, child) {
      if (message.status === "ready") child.finish(0);
    },
  });

  assert.equal(await run(testFixture), 0);
  assert.equal(
    testFixture.calls.filter(([operation]) => operation === "launch").length,
    1,
  );
  assert.equal(
    testFixture.calls.find(([operation]) => operation === "publish")[2].transport,
    "pipe",
  );
  assert.equal(testFixture.released, 1);
  assert.deepEqual(testFixture.child.kills, []);
});

test("transport-only publishes only a generic failure, stops Codex, and does not reconnect", async () => {
  const testFixture = fixture({
    async open() {
      throw new Error("raw CDP failure containing token-should-not-cross-readiness");
    },
  });

  await assert.rejects(run(testFixture), /raw CDP failure/);
  const messages = testFixture.calls
    .filter(([operation]) => operation === "publish")
    .map(([, , message]) => message);
  assert.deepEqual(messages, [{
    type: "codex-taskboard:cdp-transport",
    version: 1,
    status: "error",
    code: "CDP_TRANSPORT_FAILED",
    nonce,
  }]);
  assert.doesNotMatch(JSON.stringify(messages), /token-should-not-cross-readiness/);
  assert.equal(
    testFixture.calls.filter(([operation]) => operation === "launch").length,
    1,
  );
  assert.deepEqual(testFixture.child.kills, ["SIGTERM"]);
  assert.equal(testFixture.released, 1);
});

test("transport-only treats Codex exit during handshake as a terminal failure", async () => {
  const testFixture = fixture({
    async open(child) {
      child.finish(23);
      throw new Error("Codex exited (23)");
    },
  });

  await assert.rejects(run(testFixture), /Codex exited/);
  assert.equal(
    testFixture.calls.filter(([operation]) => operation === "launch").length,
    1,
  );
  assert.equal(
    testFixture.calls.find(([operation]) => operation === "publish")[2].status,
    "error",
  );
  assert.deepEqual(testFixture.child.kills, []);
  assert.equal(testFixture.released, 1);
});

test("transport-only CLI completes a real private-pipe handshake with Unicode paths", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex transport-only-示例 "));
  const appPath = path.join(root, "Fake ChatGPT.app");
  const executable = path.join(appPath, "Contents", "MacOS", "Fake ChatGPT");
  const outputPath = path.join(root, "fake codex output.json");
  const profilePath = path.join(root, "独立 profile");
  const readinessFile = path.join(root, "transport ready.json");
  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, `#!${process.execPath}
import { createReadStream, writeFileSync, writeSync } from "node:fs";
const input = createReadStream(null, { fd: 3, autoClose: false });
let buffer = Buffer.alloc(0);
const methods = [];
input.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (let boundary = buffer.indexOf(0); boundary !== -1; boundary = buffer.indexOf(0)) {
    const request = JSON.parse(buffer.subarray(0, boundary).toString("utf8"));
    buffer = buffer.subarray(boundary + 1);
    methods.push(request.method);
    const response = JSON.stringify({ id: request.id, result: {} }) + "\\0";
    if (methods.length === 2) {
      writeFileSync(process.env.CODEX_TRANSPORT_FIXTURE_OUTPUT, JSON.stringify({
        methods,
        arguments: process.argv.slice(2),
        userDataOverride: process.env.CODEX_ELECTRON_USER_DATA_PATH,
        leakedTaskboardNames: Object.keys(process.env).filter((name) => /^CODEX_TASKBOARD_/i.test(name)),
      }));
      writeSync(4, response);
      process.exit(0);
    } else {
      writeSync(4, response);
    }
  }
});
`);
    await chmod(executable, 0o755);
    const injector = spawn(process.execPath, [
      fileURLToPath(new URL("../scripts/codex-injector.mjs", import.meta.url)),
      "--transport-only",
      "--app-path",
      appPath,
      "--profile-path",
      profilePath,
      "--source-profile-path",
      path.join(root, "official profile"),
      "--transport-readiness-file",
      readinessFile,
      "--transport-readiness-nonce",
      nonce,
    ], {
      env: {
        ...process.env,
        CODEX_TRANSPORT_FIXTURE_OUTPUT: outputPath,
        CODEX_TASKBOARD_INSTANCE_SECRET: "must-not-reach-fake-codex",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    injector.stderr.setEncoding("utf8");
    injector.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise((resolve) => injector.once("exit", resolve));

    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      methods: ["Browser.getVersion", "Target.setDiscoverTargets"],
      arguments: [`--user-data-dir=${profilePath}`, "--remote-debugging-pipe"],
      userDataOverride: profilePath,
      leakedTaskboardNames: [],
    });
    assert.deepEqual(JSON.parse(await readFile(readinessFile, "utf8")), {
      type: "codex-taskboard:cdp-transport",
      version: 1,
      status: "ready",
      transport: "pipe",
      nonce,
    });
    await assert.rejects(
      stat(path.join(profilePath, ".codex-taskboard-profile.lock")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
