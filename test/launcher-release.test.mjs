import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const platformSource = await readFile(
  new URL("../src-tauri/src/platform/mod.rs", import.meta.url),
  "utf8",
);
const macosPlatformSource = await readFile(
  new URL("../src-tauri/src/platform/macos.rs", import.meta.url),
  "utf8",
);
const windowsPlatformSource = await readFile(
  new URL("../src-tauri/src/platform/windows.rs", import.meta.url),
  "utf8",
);
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8");
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");

test("the launcher keeps OS-specific app setup behind one platform boundary", () => {
  assert.match(launcherSource, /platform::configure_app\(app\)/);
  assert.doesNotMatch(launcherSource, /ActivationPolicy/);
  assert.match(
    launcherSource,
    /#\[cfg\(target_os = "macos"\)\]\nuse std::os::\{fd::AsRawFd, unix::process::CommandExt\};/,
  );
  assert.match(platformSource, /#\[cfg\(target_os = "macos"\)\]/);
  assert.match(platformSource, /#\[cfg\(target_os = "windows"\)\]/);
  assert.match(macosPlatformSource, /ActivationPolicy::Accessory/);
  assert.doesNotMatch(windowsPlatformSource, /ActivationPolicy/);
});

test("the launcher uses standard app directories without abandoning existing macOS data", () => {
  const [macosProductionSource] = macosPlatformSource.split("#[cfg(test)]");

  assert.match(launcherSource, /platform::app_directories\(app\)/);
  assert.doesNotMatch(launcherSource, /Library\/Application Support\/Codex Taskboard/);
  assert.match(windowsPlatformSource, /app\.path\(\)\.app_data_dir\(\)/);
  assert.match(windowsPlatformSource, /app\.path\(\)\.app_log_dir\(\)/);
  assert.match(macosPlatformSource, /app\.path\(\)\.app_data_dir\(\)/);
  assert.match(macosPlatformSource, /app\.path\(\)\.app_log_dir\(\)/);
  assert.match(macosPlatformSource, /legacy\.exists\(\)/);
  assert.doesNotMatch(macosProductionSource, /remove_dir_all/);
});

test("the macOS launcher uses one instance, serialized lifecycle changes, and a private CDP pipe", () => {
  const singleInstancePlugin = launcherSource.indexOf("tauri_plugin_single_instance::init");
  const dialogPlugin = launcherSource.indexOf("tauri_plugin_dialog::init");

  assert.ok(singleInstancePlugin >= 0);
  assert.ok(singleInstancePlugin < dialogPlugin);
  assert.doesNotMatch(launcherSource, /libc::flock/);
  assert.doesNotMatch(launcherSource, /launcher\.lock/);
  assert.doesNotMatch(launcherSource, /_instance_lock/);
  assert.match(launcherSource, /lifecycle: Mutex/);
  assert.match(launcherSource, /generation: AtomicU64/);
  assert.match(launcherSource, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/);
  assert.equal(launcherSource.match(/TcpListener::bind/g)?.length, 1);
  assert.match(launcherSource, /"--cdp-pipe"/);
  assert.doesNotMatch(launcherSource, /cdp_port/);
  assert.doesNotMatch(launcherSource, /const LAUNCHER_PORT/);
});

test("release signing is tag-only and PR CI builds the real unsigned app bundle", () => {
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch/);
  assert.match(releaseWorkflow, /git merge-base --is-ancestor/);
  assert.match(releaseWorkflow, /package\.json/);
  assert.match(releaseWorkflow, /Cargo\.toml/);
  assert.match(releaseWorkflow, /tauri\.conf\.json/);
  assert.match(releaseWorkflow, /TAG_FORCED/);
  assert.match(releaseWorkflow, /sign-macos-app\.mjs/);
  assert.match(releaseWorkflow, /notarytool submit/);
  assert.match(releaseWorkflow, /stapler validate/);
  assert.match(checkWorkflow, /tauri -- build/);
  assert.match(checkWorkflow, /--bundles app/);
  assert.match(checkWorkflow, /--no-sign/);
});

test("the launcher minimum system version matches the current Codex client requirement", () => {
  assert.equal(tauriConfig.bundle.macOS.minimumSystemVersion, "14.0");
});
