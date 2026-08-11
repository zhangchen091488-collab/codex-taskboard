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
  assert.equal(windowsSnapshot.bundle.targets, undefined);
  assert.deepEqual(windowsSnapshot.bundle.icon, ["icons/icon.png"]);
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
});
