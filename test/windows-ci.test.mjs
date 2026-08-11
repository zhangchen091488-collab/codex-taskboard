import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/check.yml", import.meta.url),
  "utf8",
);

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`\n  ${nextName}:`, start + 1);
  assert.notEqual(start, -1, `${name} job must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return workflow.slice(start, end);
}

test("Windows common CI runs install, typecheck, web build and the complete Node suite", () => {
  const source = job("windows-check", "macos-launcher");
  assert.match(source, /runs-on: windows-latest/);
  assert.match(source, /timeout-minutes: 20/);
  assert.match(source, /CI: true/);
  const commands = [...source.matchAll(/^\s+- run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(commands, [
    "npm ci",
    "npm run typecheck",
    "npm run build:web",
    "npm test",
  ]);
  assert.doesNotMatch(source, /cargo|tauri|continue-on-error|secrets\./i);
});

test("Windows common CI uses pinned, credential-free actions and Node 22 cache", () => {
  const source = job("windows-check", "macos-launcher");
  const actions = [...source.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
  assert.equal(actions.length, 2);
  for (const [, name, revision] of actions) {
    assert.match(name, /^actions\/(?:checkout|setup-node)$/);
    assert.match(revision, /^[a-f0-9]{40}$/);
  }
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /node-version: 22/);
  assert.match(source, /cache: npm/);
  assert.match(workflow, /^permissions:\s*\n\s+contents: read$/m);
});
