import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  errorCodexTransport,
  parseCodexTransportReadiness,
  publishCodexTransportReadiness,
  readyCodexTransport,
} from "../shared/codex-transport-readiness.mjs";

const nonce = "00000000-0000-4000-8000-000000000053";

test("transport readiness accepts only a nonce-bound private pipe", () => {
  assert.deepEqual(parseCodexTransportReadiness(readyCodexTransport(nonce), nonce), {
    type: "codex-taskboard:cdp-transport",
    version: 1,
    status: "ready",
    transport: "pipe",
    nonce,
  });
  assert.deepEqual(parseCodexTransportReadiness(errorCodexTransport(nonce), nonce), {
    type: "codex-taskboard:cdp-transport",
    version: 1,
    status: "error",
    code: "CDP_TRANSPORT_FAILED",
    nonce,
  });
});

test("transport readiness rejects stale, public, malformed and secret-bearing messages", () => {
  for (const value of [
    { ...readyCodexTransport(nonce), nonce: "stale-nonce" },
    { ...readyCodexTransport(nonce), transport: "port" },
    { ...readyCodexTransport(nonce), version: 2 },
    { ...readyCodexTransport(nonce), token: "must-not-be-accepted" },
    { ...errorCodexTransport(nonce), code: "RAW_ERROR_DETAIL" },
    null,
  ]) {
    assert.throws(() => parseCodexTransportReadiness(value, nonce));
  }
});

test("readiness publication is atomic and removes an interrupted temporary file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-transport-readiness-"));
  try {
    const filePath = path.join(root, "ready.json");
    await publishCodexTransportReadiness(filePath, readyCodexTransport(nonce));
    assert.deepEqual(
      parseCodexTransportReadiness(JSON.parse(await readFile(filePath, "utf8")), nonce),
      readyCodexTransport(nonce),
    );

    const interruptedPath = path.join(root, "interrupted.json");
    await assert.rejects(publishCodexTransportReadiness(
      interruptedPath,
      errorCodexTransport(nonce),
      {
        createId: () => "fixture",
        async moveFile() {
          const error = new Error("simulated interruption with raw-cookie-token");
          error.code = "EIO";
          throw error;
        },
      },
    ));
    await assert.rejects(
      readFile(`${interruptedPath}.${process.pid}-fixture.tmp`),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(readFile(interruptedPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
