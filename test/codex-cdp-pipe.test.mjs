import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  CdpPipeBrowser,
  validatedLoopbackCdpWebSocketUrl,
} from "../scripts/codex-cdp-pipe.mjs";

test("the development TCP bridge accepts only its exact loopback page endpoint", () => {
  assert.equal(
    validatedLoopbackCdpWebSocketUrl(
      "ws://127.0.0.1:9231/devtools/page/target-id",
      9231,
    ),
    "ws://127.0.0.1:9231/devtools/page/target-id",
  );
  assert.throws(
    () => validatedLoopbackCdpWebSocketUrl(
      "ws://127.0.0.1:9232/devtools/page/target-id",
      9231,
    ),
    /Rejected unexpected Codex CDP target URL/,
  );
  assert.throws(
    () => validatedLoopbackCdpWebSocketUrl(
      "ws://example.com:9231/devtools/page/target-id",
      9231,
    ),
    /Rejected unexpected Codex CDP target URL/,
  );
});

test("the private browser transport exchanges NUL-delimited CDP messages over inherited pipes", async () => {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  const browser = new CdpPipeBrowser(child);
  const requests = [];
  child.stdio[3].on("data", (chunk) => {
    for (const source of chunk.toString("utf8").split("\0").filter(Boolean)) {
      const request = JSON.parse(source);
      requests.push(request);
      child.stdio[4].write(`${JSON.stringify({ id: request.id, result: {} })}\0`);
    }
  });

  await browser.open();
  assert.deepEqual(
    requests.map((request) => request.method),
    ["Browser.getVersion", "Target.setDiscoverTargets"],
  );
  assert.equal(requests.some((request) => "url" in request), false);
  browser.close();
});

function fakePipeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  return child;
}

test("the private browser transport rejects a malformed NUL-delimited frame", async () => {
  const child = fakePipeChild();
  const browser = new CdpPipeBrowser(child, { commandTimeoutMs: 100 });
  child.stdio[3].once("data", () => child.stdio[4].write("not-json\0"));
  await assert.rejects(browser.open(), /Malformed CDP pipe message/);
  browser.close();
});

test("the private browser transport times out a missing handshake response", async () => {
  const child = fakePipeChild();
  const browser = new CdpPipeBrowser(child, { commandTimeoutMs: 5 });
  await assert.rejects(browser.open(), /Timed out waiting for CDP command Browser\.getVersion/);
  browser.close();
});

test("the private browser transport rejects when Codex exits during handshake", async () => {
  const child = fakePipeChild();
  const browser = new CdpPipeBrowser(child, { commandTimeoutMs: 100 });
  child.stdio[3].once("data", () => {
    child.exitCode = 19;
    child.emit("exit", 19, null);
  });
  await assert.rejects(browser.open(), /Codex exited \(19\)/);
  browser.close();
});
