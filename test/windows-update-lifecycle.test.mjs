import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = (await readFile(
  new URL("../src-tauri/src/main.rs", import.meta.url),
  "utf8",
)).replaceAll("\r\n", "\n");
const updateStateSource = (await readFile(
  new URL("../src-tauri/src/update_state.rs", import.meta.url),
  "utf8",
)).replaceAll("\r\n", "\n");

function functionBody(name, nextName) {
  const start = launcherSource.indexOf(`fn ${name}`);
  const end = launcherSource.indexOf(`fn ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return launcherSource.slice(start, end);
}

test("Windows persists update intent only after download verification and before Job stop", () => {
  const installBody = functionBody("install_update", "finish_update_flow");
  const download = installBody.indexOf(".download(");
  const persist = installBody.indexOf("persist_update_install_intent");
  const markInstalling = installBody.indexOf("update_in_progress.store(true");
  const stopTree = installBody.indexOf("stop_managed_child_locked");
  const install = installBody.indexOf("update.install(&bytes)");
  assert.ok(download < persist);
  assert.ok(persist < markInstalling);
  assert.ok(markInstalling < stopTree);
  assert.ok(stopTree < install);
  assert.match(installBody, /无法准备安全更新状态，尚未停止任务面板/);
});

test("cancel and download or signature failure leave the running service available", () => {
  const installBody = functionBody("install_update", "finish_update_flow");
  const offerBody = functionBody("offer_update", "main");
  const downloadFailure = installBody.slice(
    installBody.indexOf("Update download failed"),
    installBody.indexOf("更新签名验证通过"),
  );
  assert.match(downloadFailure, /update_available = true/);
  assert.doesNotMatch(downloadFailure, /stop_managed_child_locked|persist_update_install_intent/);
  assert.match(offerBody, /if !install_now/);
  assert.equal(
    (offerBody.match(/Update \{version\} deferred by user/g) ?? []).length,
    1,
  );
});

test("install failure clears intent, restarts once, and reports recovery failure", () => {
  const installBody = functionBody("install_update", "finish_update_flow");
  const failure = installBody.slice(installBody.indexOf("if let Err(error) = update.install"));
  assert.match(failure, /clear_update_install_intent/);
  assert.equal((failure.match(/start_launcher_locked/g) ?? []).length, 1);
  assert.match(failure, /update_in_progress.store\(false/);
  assert.match(failure, /任务面板恢复失败/);
  assert.match(failure, /更新状态清理失败/);
  assert.match(failure, /app\.restart\(\)/);
});

test("startup consumes the versioned intent while macOS wrappers remain no-op", () => {
  assert.match(
    launcherSource,
    /recover_update_install_intent\(&app\.handle\(\)\.clone\(\), &state\)/,
  );
  assert.match(
    launcherSource,
    /#\[cfg\(target_os = "windows"\)\][\s\S]*?consume_install_intent/,
  );
  assert.match(
    launcherSource,
    /#\[cfg\(not\(target_os = "windows"\)\)\][\s\S]*?fn recover_update_install_intent\([^}]+\}\n/,
  );
  assert.match(updateStateSource, /deny_unknown_fields/);
  assert.match(updateStateSource, /phase != "installing"/);
  assert.match(
    updateStateSource,
    /remove_install_intent\(path\)\?;\s*let intent = parsed\?/,
  );
});

test("application exit is blocked during install except for Tauri restart", () => {
  assert.match(
    launcherSource,
    /code != Some\(tauri::RESTART_EXIT_CODE\)[\s\S]*?update_in_progress\.load[\s\S]*?api\.prevent_exit\(\)/,
  );
  assert.match(
    launcherSource,
    /if state\.update_in_progress\.load\(Ordering::SeqCst\) \{\s*return;/,
  );
});
