import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [environmentCapture, productionCapture] = await Promise.all([
  readFile(new URL("../scripts/capture-windows-environment-evidence.ps1", import.meta.url), "utf8"),
  readFile(new URL("../scripts/capture-windows-production-evidence.ps1", import.meta.url), "utf8"),
]);

test("environment capture records official package identity without exporting paths", () => {
  assert.match(environmentCapture, /Get-AppxPackage -Name "OpenAI\.Codex"/);
  assert.match(environmentCapture, /PackageFamilyName/);
  assert.match(environmentCapture, /WindowsBuiltInRole\]::Administrator/);
  assert.match(environmentCapture, /sourceAndIndependentOverlap/);
  assert.match(environmentCapture, /FileMode\]::CreateNew/);
  assert.doesNotMatch(environmentCapture, /InstallLocation\s*=/);
  assert.doesNotMatch(environmentCapture, /codexExecutable\s*=\s*\[ordered\]/i);
});

test("production capture stores capability booleans instead of raw command lines or logs", () => {
  assert.match(productionCapture, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(productionCapture, /--cdp-pipe/);
  assert.match(productionCapture, /--bounded-launcher-lifecycle/);
  assert.match(productionCapture, /inside its Job Object/);
  assert.match(productionCapture, /Windows Codex private CDP pipe is ready/);
  assert.match(productionCapture, /taskctl\.cmd/);
  assert.match(productionCapture, /discoveredExecutableExists/);
  assert.match(productionCapture, /FileMode\]::CreateNew/);
  assert.doesNotMatch(productionCapture, /commandLine\s*=/i);
  assert.doesNotMatch(productionCapture, /logContent|launcherLog\s*=/i);
});

test("cleanup capture executes scoped Windows lifecycle tests and never kills processes", () => {
  assert.match(productionCapture, /platform::windows::tests::/);
  assert.match(productionCapture, /ConfirmNoUnrelatedTermination/);
  assert.match(productionCapture, /jobObjectKillOnClose = \$lifecycleTestsPassed/);
  assert.match(productionCapture, /pidReuseGuarded = \$lifecycleTestsPassed/);
  assert.doesNotMatch(
    `${environmentCapture}\n${productionCapture}`,
    /Stop-Process|taskkill|TerminateProcess|Remove-Item|Remove-ItemProperty/,
  );
});
