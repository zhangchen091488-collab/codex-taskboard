import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  assertWindowsX64Pe,
  dispatchPreparation,
  ensureVerifiedArchive,
  parsePrepareArguments,
  windowsTaskctlWrapper,
  windowsZipExtractionCommand,
} from "../scripts/prepare-tauri-app.mjs";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

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

test("verified archives reuse valid offline cache entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-node-cache-"));
  try {
    const contents = Buffer.from("reviewed archive contents");
    const archivePath = path.join(directory, "node.zip");
    await writeFile(archivePath, contents);
    let fetchCalls = 0;
    const result = await ensureVerifiedArchive({
      archivePath,
      expectedChecksum: sha256(contents),
      url: "https://example.invalid/node.zip",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("offline cache must avoid the network");
      },
    });

    assert.deepEqual(result, { archivePath, fromCache: true });
    assert.equal(fetchCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive downloads verify before replacing cache and remove temporary files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-node-download-"));
  try {
    const archivePath = path.join(directory, "node.zip");
    const previousContents = Buffer.from("previous corrupt cache");
    const expectedContents = Buffer.from("reviewed replacement archive");
    await writeFile(archivePath, previousContents);

    await assert.rejects(
      ensureVerifiedArchive({
        archivePath,
        expectedChecksum: sha256(expectedContents),
        url: "https://example.invalid/node.zip",
        fetchImpl: async () => new Response("tampered download"),
      }),
      /Checksum verification failed.*expected.*received/,
    );
    assert.deepEqual(await readFile(archivePath), previousContents);
    assert.deepEqual(await readdir(directory), ["node.zip"]);

    const result = await ensureVerifiedArchive({
      archivePath,
      expectedChecksum: sha256(expectedContents),
      url: "https://example.invalid/node.zip",
      fetchImpl: async () => new Response(expectedContents),
    });
    assert.deepEqual(result, { archivePath, fromCache: false });
    assert.deepEqual(await readFile(archivePath), expectedContents);
    assert.deepEqual(await readdir(directory), ["node.zip"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows ZIP extraction uses argument arrays on supported build hosts", () => {
  const archivePath = String.raw`C:\build cache\node.zip`;
  const destination = String.raw`C:\build cache\extracted`;
  assert.deepEqual(
    windowsZipExtractionCommand(archivePath, destination, {
      platform: "win32",
      environment: { SystemRoot: String.raw`D:\Windows` },
    }),
    {
      command: String.raw`D:\Windows\System32\tar.exe`,
      args: ["-xf", archivePath, "-C", destination],
    },
  );
  assert.deepEqual(windowsZipExtractionCommand("/tmp/node.zip", "/tmp/out", {
    platform: "darwin",
  }), {
    command: "/usr/bin/ditto",
    args: ["-x", "-k", "/tmp/node.zip", "/tmp/out"],
  });
  assert.deepEqual(windowsZipExtractionCommand("/tmp/node.zip", "/tmp/out", {
    platform: "linux",
  }), {
    command: "unzip",
    args: ["-q", "/tmp/node.zip", "-d", "/tmp/out"],
  });
  assert.throws(
    () => windowsZipExtractionCommand("node.zip", "out", { platform: "aix" }),
    /ZIP extraction is not supported on platform: aix/,
  );
});

test("PE validation accepts only x86_64 Windows executables", () => {
  const pe = Buffer.alloc(128);
  pe.write("MZ", 0, "ascii");
  pe.writeUInt32LE(64, 0x3c);
  pe.write("PE\u0000\u0000", 64, "binary");
  pe.writeUInt16LE(0x8664, 68);
  assert.doesNotThrow(() => assertWindowsX64Pe(pe, "fixture.exe"));

  const x86 = Buffer.from(pe);
  x86.writeUInt16LE(0x014c, 68);
  assert.throws(
    () => assertWindowsX64Pe(x86, "fixture.exe"),
    /machine 0x14c; expected x86_64/,
  );
  assert.throws(
    () => assertWindowsX64Pe(Buffer.from("not an executable"), "fixture.exe"),
    /not a valid PE executable/,
  );
});

test("Windows taskctl wrapper resolves only packaged files and preserves CLI behavior", () => {
  const wrapper = windowsTaskctlWrapper();
  assert.equal(wrapper.replaceAll("\r\n", "").includes("\n"), false);
  assert.match(wrapper, /for %%I in \("%~dp0\.\."\) do set "APP_DIR=%%~fI"/);
  assert.match(wrapper, /set "NODE_EXE=%APP_DIR%\\node\.exe"/);
  assert.match(wrapper, /set "TASKCTL_CLI=%APP_DIR%\\app\\cli\\taskctl\.mjs"/);
  assert.match(
    wrapper,
    /set "CODEX_TASKBOARD_DATA_DIR=%APPDATA%\\com\.chuspeeism\.codex-taskboard"/,
  );
  assert.match(wrapper, /"%NODE_EXE%" "%TASKCTL_CLI%" %\*/);
  assert.match(wrapper, /set "TASKCTL_EXIT_CODE=%ERRORLEVEL%"/);
  assert.match(wrapper, /endlocal & exit \/b %TASKCTL_EXIT_CODE%/);
  assert.doesNotMatch(wrapper, /\bwhere(?:\.exe)?\s+node\b/i);
  assert.doesNotMatch(wrapper, /(?:^|\r\n)\s*(?:call\s+)?node(?:\.exe)?(?:\s|")/im);
  assert.doesNotMatch(wrapper, /Users\\|workspace\\|Program Files/i);
});
