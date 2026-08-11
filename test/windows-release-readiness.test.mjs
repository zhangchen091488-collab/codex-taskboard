import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const audit = await readFile(
  new URL("../docs/windows-release-readiness.md", import.meta.url),
  "utf8",
);

test("release readiness remains NO-GO until remote and Windows evidence exists", () => {
  assert.match(audit, /\*\*NO-GO for a production Windows release\.\*\*/);
  assert.match(audit, /Protected Windows release workflow is not integrated/);
  assert.match(audit, /Windows runtime has not run on Windows 11 x64/);
  assert.match(audit, /Seven-stage install\/update\/uninstall matrix/);
  assert.match(audit, /Production macOS signing\/notarization/);
  assert.match(audit, /docs\/windows-runtime-validation\.md/);
  assert.match(audit, /app:verify:windows-runtime/);
  assert.match(audit, /decision: go/);
});

test("release readiness defines the exact cross-platform assets and unique publisher", () => {
  const assetLines = audit.match(/^\d+\. `[^`]+`$/gm) ?? [];
  assert.equal(assetLines.length, 8);
  assert.match(audit, /six Darwin[\s\S]*`windows-x86_64`/);
  assert.match(audit, /only actor allowed to change `draft: true` to `draft: false`/);
  assert.match(audit, /hash all eight/);
});

test("release readiness contains rollback and secret-safe handoff boundaries", () => {
  assert.match(audit, /every failure leaves the GitHub Release as Draft/);
  assert.match(audit, /Never downgrade users/);
  assert.match(audit, /published immutable Release is not edited in place/);
  assert.match(audit, /Do not distribute this setup/);
  assert.doesNotMatch(audit, /BEGIN PRIVATE KEY|WINDOWS_CERTIFICATE=/);
});
