import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { chromiumCandidates } from "./helpers/chromium-executable.mjs";

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("Codex CLI fixtures use Node argument prefixes without shell execution", async () => {
  const [runner, server, appServer] = await Promise.all([
    source("./ai-chat-runner.test.mjs"),
    source("./server.test.mjs"),
    source("./ai-chat-server.test.mjs"),
  ]);
  for (const fixture of [runner, server, appServer]) {
    assert.doesNotMatch(fixture, /#!\/|chmod\(|shell:\s*true/);
    assert.match(fixture, /codexExecutable:\s*process\.execPath/);
    assert.match(fixture, /codexArgsPrefix:/);
  }
});

test("directory-link safety fixtures use Windows junctions instead of skipping", async () => {
  const [profile, appServer] = await Promise.all([
    source("./codex-profile.test.mjs"),
    source("./ai-chat-server.test.mjs"),
  ]);
  for (const fixture of [profile, appServer]) {
    assert.match(fixture, /process\.platform === "win32" \? "junction" : "dir"/);
  }
  assert.doesNotMatch(profile, /destination (?:symlink|directory link)[\s\S]*?skip:/i);
});

test("browser fixture discovery includes standard Windows Chrome and Edge locations", () => {
  const candidates = chromiumCandidates({
    PROGRAMFILES: String.raw`C:\Program Files`,
    "PROGRAMFILES(X86)": String.raw`C:\Program Files (x86)`,
    LOCALAPPDATA: String.raw`C:\Users\示例\AppData\Local`,
  });
  assert.ok(candidates.some((candidate) => candidate.endsWith("Chrome\\Application\\chrome.exe")));
  assert.ok(candidates.some((candidate) => candidate.endsWith("Edge\\Application\\msedge.exe")));
});

test("the complete Node test command excludes executable fixture modules on every shell", async () => {
  const [packageSource, runner] = await Promise.all([
    source("../package.json"),
    source("../scripts/run-tests.mjs"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts.test, "node scripts/run-tests.mjs");
  assert.match(runner, /readdir\(testDirectory, \{ withFileTypes: true \}\)/);
  assert.match(runner, /entry\.isFile\(\) && entry\.name\.endsWith\("\.test\.mjs"\)/);
  assert.match(runner, /spawn\(process\.execPath, \["--test", \.\.\.testFiles\]/);
  assert.doesNotMatch(runner, /recursive|fixtures/);
});
