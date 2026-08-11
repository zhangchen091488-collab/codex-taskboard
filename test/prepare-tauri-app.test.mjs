import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchPreparation,
  parsePrepareArguments,
} from "../scripts/prepare-tauri-app.mjs";

test("prepare target parsing chooses platform defaults without touching resources", () => {
  assert.deepEqual(parsePrepareArguments([], { hostPlatform: "darwin" }), {
    platform: "darwin",
    target: "universal-apple-darwin",
  });
  assert.deepEqual(parsePrepareArguments([], { hostPlatform: "win32" }), {
    platform: "win32",
    target: "x86_64-pc-windows-msvc",
  });
});

test("explicit Tauri targets select their platform independently of the host", () => {
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "universal-apple-darwin",
  ]) {
    assert.deepEqual(parsePrepareArguments(["--target", target], { hostPlatform: "win32" }), {
      platform: "darwin",
      target,
    });
  }
  assert.deepEqual(
    parsePrepareArguments(["--target", "x86_64-pc-windows-msvc"], {
      hostPlatform: "darwin",
    }),
    { platform: "win32", target: "x86_64-pc-windows-msvc" },
  );
});

test("prepare argument parsing rejects ambiguous and unsupported input", () => {
  assert.throws(
    () => parsePrepareArguments([], { hostPlatform: "linux" }),
    /Unsupported preparation platform: linux/,
  );
  assert.throws(
    () => parsePrepareArguments(["--target"]),
    /--target option requires a value/,
  );
  assert.throws(
    () => parsePrepareArguments(["--target", "--other"]),
    /--target option requires a value/,
  );
  assert.throws(
    () => parsePrepareArguments(["--target", "first", "--target", "second"]),
    /--target option may only be specified once/,
  );
  assert.throws(
    () => parsePrepareArguments(["--platform", "windows"]),
    /Unknown option: --platform/,
  );
  assert.throws(
    () => parsePrepareArguments(["--target", "aarch64-unknown-linux"]),
    /Unsupported Tauri target: aarch64-unknown-linux/,
  );
});

test("dispatcher invokes exactly the handler selected by the parsed target", async () => {
  const calls = [];
  const handlers = {
    darwin: async (target) => calls.push(["darwin", target]),
    win32: async (target) => calls.push(["win32", target]),
  };

  await dispatchPreparation(
    parsePrepareArguments(["--target", "x86_64-pc-windows-msvc"]),
    handlers,
  );
  assert.deepEqual(calls, [["win32", "x86_64-pc-windows-msvc"]]);
  await assert.rejects(
    dispatchPreparation({ platform: "aix", target: "powerpc-ibm-aix" }, handlers),
    /Unsupported preparation platform: aix/,
  );
});
