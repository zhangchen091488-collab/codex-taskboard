import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [readme, windowsGuide, runtimeGuide] = await Promise.all([
  readFile(new URL("../README.md", import.meta.url), "utf8"),
  readFile(new URL("../docs/windows-installation.md", import.meta.url), "utf8"),
  readFile(new URL("../docs/windows-runtime-validation.md", import.meta.url), "utf8"),
]);

test("README exposes Windows readiness without claiming a production release", () => {
  assert.match(readme, /Windows 11 x64/);
  assert.match(readme, /尚未发布正式 Windows 安装包/);
  assert.match(readme, /docs\/windows-installation\.md/);
  assert.match(readme, /docs\/windows-runtime-validation\.md/);
  assert.doesNotMatch(readme, /当前不提供 Windows/);
});

test("Windows runtime guide is local, ordered and evidence-complete", () => {
  assert.match(runtimeGuide, /不需要远程桌面/);
  assert.match(runtimeGuide, /app:probe:windows-runtime/);
  assert.match(runtimeGuide, /capture-windows-environment-evidence\.ps1/);
  assert.match(runtimeGuide, /capture-windows-production-evidence\.ps1/);
  assert.match(runtimeGuide, /app:verify:windows-runtime/);
  assert.match(runtimeGuide, /-Scenario normal-exit/);
  assert.match(runtimeGuide, /-Scenario forced-exit/);
  assert.match(runtimeGuide, /-Scenario parent-exit/);
  assert.match(runtimeGuide, /-ConfirmScenarioObserved/);
  assert.match(runtimeGuide, /六个去敏 JSON/);
  assert.ok(
    runtimeGuide.indexOf("-Scenario normal-exit")
      < runtimeGuide.indexOf("-Scenario forced-exit"),
  );
  assert.ok(
    runtimeGuide.indexOf("-Scenario forced-exit")
      < runtimeGuide.indexOf("-Scenario parent-exit"),
  );
  assert.doesNotMatch(runtimeGuide, /mstsc|WinRM|Enter-PSSession|Invoke-Command/i);
  assert.doesNotMatch(runtimeGuide, /Stop-Process|taskkill|TerminateProcess/);
});

test("Windows guide uses source-backed paths and packaged taskctl", () => {
  assert.match(windowsGuide, /%APPDATA%\\com\.chuspeeism\.codex-taskboard/);
  assert.match(windowsGuide, /%LOCALAPPDATA%\\com\.chuspeeism\.codex-taskboard\\logs/);
  assert.match(windowsGuide, /windows-update-state\.json/);
  assert.match(windowsGuide, /bin\\taskctl\.cmd/);
  assert.match(windowsGuide, /launcher-runtime\.json/);
  assert.match(windowsGuide, /InstallLocation/);
  assert.doesNotMatch(windowsGuide, /C:\\Program Files\\Codex Taskboard/);
});

test("Windows guide preserves signing, WebView2 and evidence boundaries", () => {
  assert.match(windowsGuide, /downloadBootstrapper/);
  assert.match(windowsGuide, /Get-AuthenticodeSignature/);
  assert.match(windowsGuide, /TimeStamperCertificate/);
  assert.match(windowsGuide, /allowDowngrades.*false/);
  assert.match(windowsGuide, /不要上传数据库、附件、Codex profile/);
  assert.match(windowsGuide, /unsigned、仅用于 CI\/本机验收/);
});
