import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const platformSource = await readFile(
  new URL("../src-tauri/src/platform/mod.rs", import.meta.url),
  "utf8",
);
const launcherRecordSource = await readFile(
  new URL("../src-tauri/src/launcher_record.rs", import.meta.url),
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
const rustReadinessSource = await readFile(
  new URL("../src-tauri/src/readiness.rs", import.meta.url),
  "utf8",
);
const nodeReadinessSource = await readFile(
  new URL("../shared/taskboard-readiness.mjs", import.meta.url),
  "utf8",
);
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const tauriMacosConfig = JSON.parse(await readFile(
  new URL("../src-tauri/tauri.macos.conf.json", import.meta.url),
  "utf8",
));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8");
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");

test("the launcher keeps OS-specific app setup behind one platform boundary", () => {
  assert.match(launcherSource, /platform::configure_app\(app\)/);
  assert.doesNotMatch(launcherSource, /ActivationPolicy/);
  assert.doesNotMatch(launcherSource, /std::os::unix::process::CommandExt/);
  assert.match(platformSource, /#\[cfg\(target_os = "macos"\)\]/);
  assert.match(platformSource, /#\[cfg\(target_os = "windows"\)\]/);
  assert.match(macosPlatformSource, /os::unix::process::CommandExt/);
  assert.match(macosPlatformSource, /ActivationPolicy::Accessory/);
  assert.doesNotMatch(windowsPlatformSource, /ActivationPolicy/);
  assert.match(
    launcherSource,
    /#\[cfg\(target_os = "windows"\)\]\nfn start_launcher_locked[\s\S]*Windows launcher backend is not implemented yet/,
  );
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

test("the launcher builds PATH with platform separators and keeps the inherited entries", () => {
  assert.match(launcherSource, /platform::launcher_path/);
  assert.match(platformSource, /split_paths/);
  assert.match(platformSource, /join_paths/);
  assert.match(platformSource, /resource_directory\.join\("bin"\)/);
  assert.doesNotMatch(launcherSource, /\/opt\/homebrew\/bin/);
  assert.doesNotMatch(launcherSource, /\/usr\/local\/bin:/);
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
  assert.match(launcherSource, /CODEX_TASKBOARD_PORT", "0"/);
  assert.doesNotMatch(launcherSource, /TcpListener::bind/);
  assert.doesNotMatch(launcherSource, /CODEX_TASKBOARD_LISTEN_FD/);
  assert.doesNotMatch(launcherSource, /\b(?:dup2|fcntl|pre_exec)\b/);
  assert.match(launcherSource, /"--cdp-pipe"/);
  assert.doesNotMatch(launcherSource, /cdp_port/);
  assert.doesNotMatch(launcherSource, /const LAUNCHER_PORT/);
});

test("macOS process-group lifecycle stays behind the ProcessTree implementation", () => {
  assert.match(macosPlatformSource, /impl ProcessTree for MacProcessTree/);
  assert.match(macosPlatformSource, /command\.process_group\(0\)/);
  assert.match(macosPlatformSource, /libc::SIGTERM/);
  assert.match(macosPlatformSource, /libc::SIGKILL/);
  assert.match(macosPlatformSource, /Duration::from_millis\(100\)/);
  assert.match(launcherSource, /stop_gracefully\(STOP_TIMEOUT\)/);
  assert.match(launcherSource, /force_stop\(Duration::from_secs\(1\)\)/);
  assert.doesNotMatch(launcherSource, /libc::kill|terminate_process_group|\.process_group\(0\)/);
});

test("Windows process-tree lifecycle owns a kill-on-close Job Object", () => {
  assert.match(windowsPlatformSource, /impl ProcessTree for WindowsProcessTree/);
  assert.match(windowsPlatformSource, /CreateJobObjectW/);
  assert.match(windowsPlatformSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(windowsPlatformSource, /AssignProcessToJobObject/);
  assert.match(windowsPlatformSource, /QueryInformationJobObject/);
  assert.match(windowsPlatformSource, /TerminateJobObject/);
  assert.match(windowsPlatformSource, /OwnedHandle/);
  assert.match(platformSource, /WindowsProcessTree as NativeProcessTree/);
  assert.match(launcherSource, /process_tree: NativeProcessTree/);
  assert.doesNotMatch(
    launcherSource,
    /CreateJobObjectW|AssignProcessToJobObject|TerminateJobObject|JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/,
  );
});

test("stale launcher recovery requires a versioned nonce and live loopback health", () => {
  assert.doesNotMatch(launcherSource, /\/bin\/ps|process_matches_record/);
  assert.match(launcherSource, /verify_recorded_launcher/);
  assert.match(launcherSource, /clear_record_if_matches/);
  assert.match(launcherRecordSource, /LAUNCHER_RECORD_VERSION: u32 = 2/);
  assert.match(launcherRecordSource, /create_new\(true\)/);
  assert.match(launcherRecordSource, /options\.mode\(0o600\)/);
  assert.match(launcherRecordSource, /runtime\.startup_nonce != record\.startup_nonce/);
  assert.match(launcherRecordSource, /runtime\.host != "127\.0\.0\.1"/);
  assert.match(launcherRecordSource, /GET \/health HTTP\/1\.1/);
  assert.doesNotMatch(launcherRecordSource, /Command::new|\/bin\/ps|tasklist|wmic|powershell/i);
});

test("the launcher waits for the same strict readiness frame emitted by Node", () => {
  const rustPrefix = rustReadinessSource.match(/LAUNCHER_READINESS_PREFIX: &str = "([^"]+)"/)?.[1];
  const nodePrefix = nodeReadinessSource.match(/TASKBOARD_LAUNCHER_READINESS_PREFIX = "([^"]+)"/)?.[1];

  assert.equal(rustPrefix, "CODEX_TASKBOARD_READINESS_V1 ");
  assert.equal(nodePrefix, rustPrefix);
  assert.match(launcherSource, /CODEX_TASKBOARD_LAUNCHER_READINESS", "1"/);
  assert.match(launcherSource, /wait_for_taskboard_readiness/);
  assert.match(launcherSource, /Duration::from_secs\(10\)/);
  assert.match(launcherSource, /taskboard_url: Mutex<Option<String>>/);
  assert.doesNotMatch(launcherSource, /line\.contains\("Codex Taskboard listening"\)/);
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
  assert.match(checkWorkflow, /runs-on: windows-latest/);
  assert.match(checkWorkflow, /cargo check --locked --manifest-path src-tauri\/Cargo\.toml --target x86_64-pc-windows-msvc/);
  assert.match(checkWorkflow, /npm run app:prepare:windows/);
  assert.match(checkWorkflow, /node-x86_64-pc-windows-msvc\.exe --version/);
  assert.match(checkWorkflow, /Unexpected Windows Node sidecar version/);
  assert.match(checkWorkflow, /npm run app:verify:windows-resources/);
  assert.match(checkWorkflow, /windows-taskctl-wrapper\.ps1 -ProjectRoot/);
  assert.doesNotMatch(checkWorkflow, /check-only Windows icon placeholder/);
  assert.doesNotMatch(checkWorkflow, /New-Item -ItemType File.*node-x86_64-pc-windows-msvc\.exe/);
});

test("the launcher minimum system version matches the current Codex client requirement", () => {
  assert.equal(tauriMacosConfig.bundle.macOS.minimumSystemVersion, "14.0");
  assert.equal(tauriConfig.bundle.macOS, undefined);
});
