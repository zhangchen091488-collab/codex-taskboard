import assert from "node:assert/strict";
import { test } from "node:test";

import { isCodexTarget } from "../scripts/codex-target-policy.mjs";

test("Codex target policy accepts primary renderers only", () => {
  assert.equal(isCodexTarget({ type: "page", url: "app://codex/index.html", title: "Codex" }), true);
  assert.equal(isCodexTarget({ type: "page", url: "https://example.test", title: "Codex" }), true);
  assert.equal(isCodexTarget({ type: "worker", url: "app://codex/worker", title: "Codex" }), false);
  assert.equal(isCodexTarget({ type: "page", url: "https://example.test", title: "Other" }), false);
});

test("Codex target policy rejects dictation and avatar auxiliary windows", () => {
  assert.equal(isCodexTarget({
    type: "page",
    url: "app://codex/index.html?initialRoute=%2Fglobal-dictation",
    title: "Codex",
  }), false);
  assert.equal(isCodexTarget({
    type: "page",
    url: "app://codex/index.html?initialRoute=%2Favatar-overlay",
    title: "Codex",
  }), false);
});
