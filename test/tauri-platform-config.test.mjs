import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function json(relativeUrl) {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), "utf8"));
}

function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target)
    ? structuredClone(target)
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = mergePatch(result[key], value);
    }
  }
  return result;
}

const common = await json("../src-tauri/tauri.conf.json");
const macosPatch = await json("../src-tauri/tauri.macos.conf.json");
const windowsPatch = await json("../src-tauri/tauri.windows.conf.json");
const macosSnapshot = await json("./fixtures/tauri-macos-merged.snapshot.json");
const windowsSnapshot = await json("./fixtures/tauri-windows-merged.snapshot.json");
const schema = await json("../node_modules/@tauri-apps/cli/config.schema.json");

test("platform files reproduce the reviewed Tauri merge snapshots", () => {
  assert.deepEqual(mergePatch(common, macosPatch), macosSnapshot);
  assert.deepEqual(mergePatch(common, windowsPatch), windowsSnapshot);
});

test("common configuration retains updater and shared resources", () => {
  assert.deepEqual(common.bundle.externalBin, ["binaries/node"]);
  assert.deepEqual(common.bundle.resources, { "resources/": "" });
  assert.equal(common.bundle.createUpdaterArtifacts, true);
  assert.match(common.plugins.updater.pubkey, /\S/);
  assert.deepEqual(common.plugins.updater.endpoints, [
    "https://github.com/chuspeeism/dashi-taskboard/releases/latest/download/latest.json",
  ]);
  assert.equal("targets" in common.bundle, false);
  assert.equal("macOS" in common.bundle, false);
});

test("macOS-only bundle fields do not leak into the Windows merge", () => {
  assert.deepEqual(macosSnapshot.bundle.targets, ["app", "dmg"]);
  assert.equal(macosSnapshot.bundle.macOS.minimumSystemVersion, "14.0");
  assert.equal(windowsSnapshot.bundle.macOS, undefined);
  assert.deepEqual(macosSnapshot.bundle.icon, ["icons/icon.png", "icons/icon.icns"]);
  assert.deepEqual(windowsSnapshot.bundle.targets, ["nsis"]);
  assert.deepEqual(windowsSnapshot.bundle.icon, ["icons/icon.ico"]);
  assert.equal(windowsSnapshot.bundle.createUpdaterArtifacts, false);
  assert.equal(windowsSnapshot.bundle.windows.allowDowngrades, false);
  assert.equal(macosSnapshot.bundle.windows, undefined);
  assert.deepEqual(windowsSnapshot.bundle.windows.webviewInstallMode, {
    type: "downloadBootstrapper",
    silent: true,
  });
  assert.deepEqual(windowsSnapshot.bundle.windows.nsis, {
    installMode: "currentUser",
    installerIcon: "icons/icon.ico",
  });
});

test("merged snapshots use keys declared by the installed Tauri schema", () => {
  const bundleSchema = schema.definitions.BundleConfig;
  for (const snapshot of [macosSnapshot, windowsSnapshot]) {
    for (const required of schema.required) assert.ok(required in snapshot);
    for (const key of Object.keys(snapshot)) {
      assert.ok(key in schema.properties, `unknown Tauri config key: ${key}`);
    }
    for (const key of Object.keys(snapshot.bundle)) {
      assert.ok(key in bundleSchema.properties, `unknown Tauri bundle key: ${key}`);
    }
  }
  const windowsSchema = schema.definitions.WindowsConfig;
  const nsisSchema = schema.definitions.NsisConfig;
  for (const key of Object.keys(windowsSnapshot.bundle.windows)) {
    assert.ok(key in windowsSchema.properties, `unknown Tauri Windows key: ${key}`);
  }
  for (const key of Object.keys(windowsSnapshot.bundle.windows.nsis)) {
    assert.ok(key in nsisSchema.properties, `unknown Tauri NSIS key: ${key}`);
  }
});

test("Windows icon contains the reviewed multi-size 32-bit image set", async () => {
  const icon = await readFile(new URL("../src-tauri/icons/icon.ico", import.meta.url));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const count = icon.readUInt16LE(4);
  const entries = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return {
      width: icon[offset] || 256,
      height: icon[offset + 1] || 256,
      bits: icon.readUInt16LE(offset + 6),
      byteLength: icon.readUInt32LE(offset + 8),
      imageOffset: icon.readUInt32LE(offset + 12),
    };
  });
  assert.deepEqual(entries.map(({ width, height, bits }) => ({ width, height, bits })), [
    { width: 32, height: 32, bits: 32 },
    { width: 16, height: 16, bits: 32 },
    { width: 24, height: 24, bits: 32 },
    { width: 48, height: 48, bits: 32 },
    { width: 64, height: 64, bits: 32 },
    { width: 256, height: 256, bits: 32 },
  ]);
  for (const entry of entries) {
    assert.ok(entry.byteLength > 0);
    assert.ok(entry.imageOffset + entry.byteLength <= icon.length);
  }
});
