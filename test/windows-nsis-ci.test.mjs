import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [workflow, verifier] = await Promise.all([
  readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8"),
  readFile(new URL("../scripts/verify-windows-nsis-bundle.ps1", import.meta.url), "utf8"),
]);

function windowsLauncherJob() {
  const start = workflow.indexOf("  windows-launcher-check:");
  assert.notEqual(start, -1);
  return workflow.slice(start);
}

test("Windows launcher CI builds, installs, verifies and uninstalls the real NSIS", () => {
  const source = windowsLauncherJob();
  assert.match(source, /npm run app:build:windows/);
  assert.match(source, /verify-windows-nsis-bundle\.ps1/);
  assert.match(source, /\*-setup\.exe/);
  assert.match(source, /windows-nsis-evidence\.json/);
  assert.match(source, /::error file=scripts\/verify-windows-nsis-bundle\.ps1/);
  assert.match(source, /Windows NSIS verification failed/);
  assert.doesNotMatch(
    source,
    /continue-on-error|upload-artifact|TAURI_SIGNING_PRIVATE_KEY|WINDOWS_CERTIFICATE|secrets\./,
  );
});

test("NSIS verifier is CI-only, exact-targeted and compares installed payload bytes", () => {
  assert.match(verifier, /GITHUB_ACTIONS/);
  assert.match(verifier, /RUNNER_TEMP/);
  assert.match(verifier, /DisplayName/);
  assert.match(verifier, /Codex Taskboard/);
  assert.match(verifier, /Select-Object -ExpandProperty \$Name -ErrorAction SilentlyContinue/);
  assert.match(verifier, /if \(\$null -eq \$InputObject\)/);
  assert.match(verifier, /hive -ne "HKCU"/);
  assert.match(verifier, /SignatureStatus\]::NotSigned/);
  assert.match(verifier, /Installed bundle file differs from staged source/);
  assert.match(verifier, /nodeVersion -ne "v22\.23\.2"/);
  assert.match(verifier, /Start-Process -FilePath \$uninstaller -ArgumentList "\/S"/);
  assert.match(verifier, /registryEntryRemoved = \$true/);
  assert.match(verifier, /installDirectoryRemoved = \$true/);
  assert.doesNotMatch(verifier, /Invoke-Expression|cmd\.exe|Remove-Item|Remove-ItemProperty/);
});
