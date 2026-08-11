import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [readme, windowsGuide] = await Promise.all([
  readFile(new URL("../README.md", import.meta.url), "utf8"),
  readFile(new URL("../docs/windows-installation.md", import.meta.url), "utf8"),
]);

test("README exposes Windows readiness without claiming a production release", () => {
  assert.match(readme, /Windows 11 x64/);
  assert.match(readme, /尚未发布正式 Windows 安装包/);
  assert.match(readme, /docs\/windows-installation\.md/);
  assert.doesNotMatch(readme, /当前不提供 Windows/);
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
