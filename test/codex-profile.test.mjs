import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  acquireCodexProfileLease,
  codexProfileFileNames,
  initializeIndependentCodexProfile,
  profilePathsOverlap,
} from "../shared/codex-profile.mjs";

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), "codex-profile-test-"));
}

async function assertMissing(filePath) {
  await assert.rejects(stat(filePath), (error) => error?.code === "ENOENT");
}

test("Windows profile path overlap checks are separator and case aware", () => {
  assert.equal(
    profilePathsOverlap(
      String.raw`C:\Users\示例\AppData\Roaming\Codex`,
      String.raw`c:\users\示例\appdata\roaming\codex\taskboard`,
      { platform: "win32" },
    ),
    true,
  );
  assert.equal(
    profilePathsOverlap(
      String.raw`C:\Users\示例\AppData\Roaming\Codex`,
      String.raw`C:\Users\示例\AppData\Roaming\com.codex-taskboard\codex-profile`,
      { platform: "win32" },
    ),
    false,
  );
});

test("a new independent profile is initialized without enumerating or copying official data", async () => {
  const root = await fixture();
  try {
    const source = path.join(root, "official Codex");
    const destination = path.join(root, "Taskboard", "codex-profile");
    await mkdir(path.join(source, "Default", "Network"), { recursive: true });
    await mkdir(path.join(source, "Local Storage"), { recursive: true });
    await writeFile(path.join(source, "Default", "Network", "Cookies"), "fixture-cookie");
    await writeFile(path.join(source, "Local Storage", "auth-token"), "fixture-token");
    const sourceFilesBefore = await readdir(source, { recursive: true });
    const inspectedPaths = [];

    const result = await initializeIndependentCodexProfile({
      sourceProfilePath: source,
      destinationProfilePath: destination,
      dependencies: {
        async lstat(filePath) {
          inspectedPaths.push(filePath);
          return lstat(filePath);
        },
      },
    });

    assert.equal(result.status, "created");
    assert.ok(inspectedPaths.every((filePath) => filePath.startsWith(destination)));
    assert.deepEqual(await readdir(source, { recursive: true }), sourceFilesBefore);
    assert.deepEqual(await readdir(destination), [
      codexProfileFileNames.initializationMarkerName,
    ]);
    assert.equal(
      await readFile(path.join(source, "Default", "Network", "Cookies"), "utf8"),
      "fixture-cookie",
    );
    await assertMissing(path.join(destination, "Default"));
    await assertMissing(path.join(destination, "Local Storage"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing independent profile is adopted without overwriting its files", async () => {
  const root = await fixture();
  try {
    const source = path.join(root, "official");
    const destination = path.join(root, "independent");
    const existingFile = path.join(destination, "Default", "Preferences");
    await mkdir(source, { recursive: true });
    await mkdir(path.dirname(existingFile), { recursive: true });
    await writeFile(existingFile, "existing-independent-state");

    const first = await initializeIndependentCodexProfile({
      sourceProfilePath: source,
      destinationProfilePath: destination,
    });
    const second = await initializeIndependentCodexProfile({
      sourceProfilePath: source,
      destinationProfilePath: destination,
    });

    assert.equal(first.status, "adopted");
    assert.equal(second.status, "existing");
    assert.equal(await readFile(existingFile, "utf8"), "existing-independent-state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted atomic initialization leaves no partial marker and can retry", async () => {
  const root = await fixture();
  try {
    const destination = path.join(root, "independent");
    await assert.rejects(
      initializeIndependentCodexProfile({
        sourceProfilePath: path.join(root, "official"),
        destinationProfilePath: destination,
        dependencies: {
          async writeFile(filePath, contents, options) {
            await writeFile(filePath, contents.slice(0, 1), options);
            throw new Error("simulated interruption containing fixture-token");
          },
        },
      }),
      (error) => {
        assert.equal(error.code, "CODEX_PROFILE_INITIALIZATION_FAILED");
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /fixture-token|codex-profile-test-|official Codex/);
        return true;
      },
    );
    assert.deepEqual(await readdir(destination), []);

    const retried = await initializeIndependentCodexProfile({
      sourceProfilePath: path.join(root, "official"),
      destinationProfilePath: destination,
    });
    assert.equal(retried.status, "adopted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live independent-profile lease fails safely and is retryable", async () => {
  const root = await fixture();
  try {
    const destination = path.join(root, "independent");
    await initializeIndependentCodexProfile({ destinationProfilePath: destination });
    const firstLease = await acquireCodexProfileLease(destination);

    await assert.rejects(acquireCodexProfileLease(destination), (error) => {
      assert.equal(error.code, "CODEX_PROFILE_LOCKED");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /token|cookie|nonce/i);
      return true;
    });

    await firstLease.release();
    const secondLease = await acquireCodexProfileLease(destination);
    await secondLease.release();
    await assertMissing(path.join(destination, codexProfileFileNames.leaseFileName));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale lease is reclaimed without changing independent profile contents", async () => {
  const root = await fixture();
  try {
    const destination = path.join(root, "independent");
    const existingFile = path.join(destination, "Default", "Preferences");
    await mkdir(path.dirname(existingFile), { recursive: true });
    await writeFile(existingFile, "preserve-me");
    const leasePath = path.join(destination, codexProfileFileNames.leaseFileName);
    await writeFile(leasePath, `${JSON.stringify({
      version: 1,
      pid: 999_999,
      nonce: "stale-fixture",
    })}\n`);

    const lease = await acquireCodexProfileLease(destination, {
      dependencies: {
        kill() {
          const error = new Error("not running");
          error.code = "ESRCH";
          throw error;
        },
      },
    });

    assert.equal(await readFile(existingFile, "utf8"), "preserve-me");
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping official and independent profiles are rejected before filesystem writes", async () => {
  const root = await fixture();
  try {
    const source = path.join(root, "Codex");
    const destination = path.join(source, "Taskboard profile");
    await assert.rejects(
      initializeIndependentCodexProfile({
        sourceProfilePath: source,
        destinationProfilePath: destination,
      }),
      (error) => {
        assert.equal(error.code, "CODEX_PROFILE_PATHS_OVERLAP");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    await assertMissing(destination);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a destination directory link cannot redirect initialization into the official profile", async () => {
  const root = await fixture();
  try {
    const source = path.join(root, "Codex");
    const destination = path.join(root, "codex-profile");
    await mkdir(source, { recursive: true });
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      initializeIndependentCodexProfile({
        sourceProfilePath: source,
        destinationProfilePath: destination,
      }),
      (error) => error.code === "CODEX_PROFILE_PATHS_OVERLAP",
    );
    assert.deepEqual(await readdir(source), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
