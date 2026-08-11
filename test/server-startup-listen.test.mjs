import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  createTaskboardServer,
  resolveLauncherPort,
  resolvePort,
  resolveStartupListenOptions,
} from "../server/index.mjs";

test("external port parsing still rejects ephemeral port zero", () => {
  for (const value of [0, "0", -1, "", " ", true, "65536", "12.5", "not-a-port"]) {
    assert.throws(
      () => resolvePort(value),
      /CODEX_TASKBOARD_PORT must be an integer between 1 and 65535/,
    );
  }
  assert.equal(resolvePort("47823"), 47823);
});

test("launcher port parsing accepts zero but rejects invalid ports", () => {
  assert.equal(resolveLauncherPort(0), 0);
  assert.equal(resolveLauncherPort("0"), 0);
  assert.equal(resolveLauncherPort("65535"), 65535);
  for (const value of [-1, "", " ", true, "65536", "12.5", "not-a-port"]) {
    assert.throws(
      () => resolveLauncherPort(value),
      /Launcher Taskboard port must be an integer between 0 and 65535/,
    );
  }
});

test("startup options reserve port zero for loopback launcher mode", () => {
  assert.deepEqual(resolveStartupListenOptions({}), {
    host: "0.0.0.0",
    port: 47823,
    fd: null,
  });
  assert.deepEqual(resolveStartupListenOptions({
    CODEX_TASKBOARD_INSTANCE_TOKEN: "00000000-0000-4000-8000-000000000001",
  }), {
    host: "127.0.0.1",
    port: 0,
    fd: null,
  });
  assert.throws(
    () => resolveStartupListenOptions({ CODEX_TASKBOARD_PORT: "0" }),
    /between 1 and 65535/,
  );
  assert.throws(
    () => resolveStartupListenOptions({
      CODEX_TASKBOARD_INSTANCE_TOKEN: "00000000-0000-4000-8000-000000000001",
      CODEX_TASKBOARD_HOST: "0.0.0.0",
      CODEX_TASKBOARD_PORT: "0",
    }),
    /must bind to 127\.0\.0\.1/,
  );
});

test("launcher port zero binds an OS-assigned IPv4 loopback port", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-launcher-port-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    instanceToken: "00000000-0000-4000-8000-000000000001",
    instanceSecret: "00000000-0000-4000-8000-000000000002",
  });
  try {
    const address = await app.listen(resolveStartupListenOptions({
      CODEX_TASKBOARD_INSTANCE_TOKEN: "00000000-0000-4000-8000-000000000001",
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: "0",
    }));
    assert.equal(address.address, "127.0.0.1");
    assert.equal(address.family, "IPv4");
    assert.ok(Number.isInteger(address.port));
    assert.ok(address.port >= 1 && address.port <= 65535);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
