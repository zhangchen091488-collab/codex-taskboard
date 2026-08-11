import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  createTemporaryDirectory,
  openExternal,
  openExternalCommand,
  resolveLocalBin,
  resolveNodePackageBin,
  temporaryDirectoryPrefix,
} from "../shared/platform-runtime.mjs";

const injectorSource = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const wranglerSource = await readFile(new URL("../scripts/wrangler-cloud-adapter.mjs", import.meta.url), "utf8");
const devSource = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");

test("external URL commands use argument arrays without a shell", () => {
  const url = "https://example.com/docs?q=a%20b&from=任务面板";
  const normalizedUrl = new URL(url).href;
  const environment = { SystemRoot: String.raw`D:\Windows` };

  assert.deepEqual(openExternalCommand(url, { platform: "darwin", environment }), {
    command: "/usr/bin/open",
    args: [normalizedUrl],
    options: {
      detached: true,
      env: environment,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  });
  assert.equal(
    openExternalCommand(url, { platform: "win32", environment }).command,
    String.raw`D:\Windows\explorer.exe`,
  );
  assert.equal(openExternalCommand(url, { platform: "linux" }).command, "xdg-open");
});

test("external URL validation rejects non-HTTPS, credentials, and unknown platforms", () => {
  assert.throws(() => openExternalCommand("http://example.com"), /must be HTTPS/);
  assert.throws(() => openExternalCommand("https://user:secret@example.com"), /credentials/);
  assert.throws(() => openExternalCommand("not a URL"), /valid HTTPS URL/);
  assert.throws(
    () => openExternalCommand("https://example.com", { platform: "aix" }),
    /not supported.*aix/,
  );
});

test("openExternal waits for spawn and detaches the child", async () => {
  const child = new EventEmitter();
  let detached = false;
  child.unref = () => {
    detached = true;
  };
  const calls = [];
  const resultPromise = openExternal("https://example.com/path", {
    platform: "linux",
    environment: { PATH: "/usr/bin" },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  assert.deepEqual(await resultPromise, { opened: true });
  assert.equal(detached, true);
  assert.deepEqual(calls[0].args, ["https://example.com/path"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
});

test("temporary directory prefixes use the selected platform path rules", async () => {
  assert.equal(
    temporaryDirectoryPrefix("ai-turn", {
      platform: "win32",
      temporaryRoot: String.raw`C:\Users\示例 User\AppData\Local\Temp`,
    }),
    String.raw`C:\Users\示例 User\AppData\Local\Temp\ai-turn-`,
  );
  assert.equal(
    temporaryDirectoryPrefix("ai-turn", {
      platform: "darwin",
      temporaryRoot: "/Users/示例 User/Library/Caches/TemporaryItems",
    }),
    "/Users/示例 User/Library/Caches/TemporaryItems/ai-turn-",
  );
  assert.throws(
    () => createTemporaryDirectory("../escape", {
      makeTemporaryDirectory: async () => {
        throw new Error("must not run");
      },
    }),
    /simple file name/,
  );

  const calls = [];
  assert.equal(await createTemporaryDirectory("migration", {
    temporaryRoot: "/tmp/root with spaces",
    makeTemporaryDirectory: async (prefix) => {
      calls.push(prefix);
      return `${prefix}123`;
    },
  }), "/tmp/root with spaces/migration-123");
  assert.deepEqual(calls, ["/tmp/root with spaces/migration-"]);
});

test("local bin resolution selects cmd on Windows and direct files on POSIX", () => {
  const windowsRoot = String.raw`C:\workspace with spaces\任务面板`;
  const windowsCmd = path.win32.join(windowsRoot, "node_modules", ".bin", "wrangler.cmd");
  const posixRoot = "/Users/示例 User/taskboard";
  const posixBin = path.posix.join(posixRoot, "node_modules", ".bin", "wrangler");

  assert.equal(resolveLocalBin(windowsRoot, "wrangler", {
    platform: "win32",
    isFile: (candidate) => candidate === windowsCmd,
  }), windowsCmd);
  assert.equal(resolveLocalBin(posixRoot, "wrangler", {
    platform: "darwin",
    isFile: (candidate) => candidate === posixBin,
  }), posixBin);
  assert.throws(
    () => resolveLocalBin(posixRoot, "../wrangler", { isFile: () => true }),
    /simple file name/,
  );
  assert.throws(
    () => resolveLocalBin(posixRoot, "missing", { isFile: () => false }),
    /Local command 'missing' was not found/,
  );
});

test("Node package bins execute their JS entry through Node on Windows", () => {
  const projectRoot = String.raw`C:\workspace with spaces\任务面板`;
  const packageRoot = path.win32.join(projectRoot, "node_modules", "wrangler");
  const entryPath = path.win32.join(packageRoot, "bin", "wrangler.js");
  const command = resolveNodePackageBin(projectRoot, "wrangler", "wrangler", {
    platform: "win32",
    nodeExecutable: String.raw`C:\Program Files\Taskboard\node.exe`,
    readManifest: () => ({ bin: { wrangler: "./bin/wrangler.js" } }),
    isFile: (candidate) => candidate === entryPath,
  });

  assert.deepEqual(command, {
    command: String.raw`C:\Program Files\Taskboard\node.exe`,
    args: [entryPath],
    options: { shell: false, windowsHide: true },
  });
  assert.throws(
    () => resolveNodePackageBin(projectRoot, "wrangler", "wrangler", {
      platform: "win32",
      readManifest: () => ({ bin: { wrangler: "../../outside.js" } }),
      isFile: () => true,
    }),
    /does not resolve to a local file/,
  );
});

test("production URL and local CLI call sites use platform descriptors without shell strings", () => {
  assert.match(injectorSource, /openExternal\(request\.url/);
  assert.doesNotMatch(injectorSource, /spawn\("\/usr\/bin\/open"/);
  assert.match(wranglerSource, /resolveNodePackageBin\(projectRoot, "wrangler"\)/);
  assert.doesNotMatch(wranglerSource, /node_modules["'], ["']\.bin["'], ["']wrangler/);
  assert.match(devSource, /process\.env\.npm_execpath/);
  assert.match(devSource, /spawn\(process\.execPath, \[npmCliPath, "run", "dev:web"\]/);
  assert.doesNotMatch(devSource, /npm\.cmd|shell:\s*true/);
});
