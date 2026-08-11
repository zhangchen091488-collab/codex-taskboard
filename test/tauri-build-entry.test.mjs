import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createTauriBuildPlan,
  executeTauriBuildPlan,
} from "../scripts/build-tauri-app.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");
const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release-macos.yml", import.meta.url),
  "utf8",
);
const planOptions = {
  nodeExecutable: "/reviewed/node",
  npmCliPath: "/reviewed/npm-cli.js",
  tauriCliPath: "/reviewed/tauri.js",
};

test("platform npm entries expose explicit prepare and build commands", () => {
  assert.match(packageJson.scripts["app:prepare:macos"], /universal-apple-darwin/);
  assert.match(packageJson.scripts["app:prepare:windows"], /x86_64-pc-windows-msvc/);
  assert.match(packageJson.scripts["app:build:macos"], /universal-apple-darwin/);
  assert.match(packageJson.scripts["app:build:windows"], /x86_64-pc-windows-msvc/);
  assert.equal(packageJson.scripts["app:build"], "node scripts/build-tauri-app.mjs");
  for (const script of Object.values(packageJson.scripts)) {
    assert.doesNotMatch(script, /(?:^|\s)CI=true(?:\s|$)/);
  }
});

test("macOS build plan uses explicit prepare, bundles, and process environment", () => {
  const plan = createTauriBuildPlan(["--dry-run"], {
    ...planOptions,
    hostPlatform: "darwin",
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.signed, false);
  assert.equal(plan.target, "universal-apple-darwin");
  assert.deepEqual(plan.steps[0], {
    name: "prepare-macos",
    command: "/reviewed/node",
    args: ["/reviewed/npm-cli.js", "run", "app:prepare:macos"],
    environment: {},
  });
  assert.deepEqual(plan.steps[1], {
    name: "tauri-build",
    command: "/reviewed/node",
    args: [
      "/reviewed/tauri.js",
      "build",
      "--target",
      "universal-apple-darwin",
      "--bundles",
      "app,dmg",
    ],
    environment: { CI: "true" },
  });
});

test("Windows build plan creates an unsigned NSIS without requiring updater keys", () => {
  const plan = createTauriBuildPlan([], {
    ...planOptions,
    hostPlatform: "win32",
  });
  assert.equal(plan.target, "x86_64-pc-windows-msvc");
  assert.equal(plan.signed, false);
  assert.deepEqual(plan.steps[0].args, [
    "/reviewed/npm-cli.js",
    "run",
    "app:prepare:windows",
  ]);
  assert.deepEqual(plan.steps[1].args, [
    "/reviewed/tauri.js",
    "build",
    "--target",
    "x86_64-pc-windows-msvc",
    "--bundles",
    "nsis",
    "--no-sign",
    "--config",
    '{"bundle":{"createUpdaterArtifacts":false}}',
  ]);
  assert.deepEqual(plan.steps[1].environment, { CI: "true" });
});

test("signed Windows build fails closed and passes only public signing metadata to Tauri", () => {
  const plan = createTauriBuildPlan(["--sign"], {
    ...planOptions,
    hostPlatform: "win32",
    environment: {
      WINDOWS_CERTIFICATE_THUMBPRINT: "0123456789abcdef0123456789abcdef01234567",
      WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test/rfc3161",
      WINDOWS_TIMESTAMP_PROTOCOL: "rfc3161",
    },
  });
  assert.equal(plan.signed, true);
  assert.doesNotMatch(JSON.stringify(plan), /CERTIFICATE_PASSWORD|PRIVATE_KEY|PFX/);
  assert.deepEqual(plan.steps[1].args, [
    "/reviewed/tauri.js",
    "build",
    "--target",
    "x86_64-pc-windows-msvc",
    "--bundles",
    "nsis",
    "--config",
    '{"bundle":{"createUpdaterArtifacts":false,"windows":{"certificateThumbprint":"0123456789ABCDEF0123456789ABCDEF01234567","digestAlgorithm":"sha256","timestampUrl":"https://timestamp.example.test/rfc3161","tsp":true}}}',
  ]);
  assert.throws(
    () => createTauriBuildPlan(["--sign"], {
      ...planOptions,
      hostPlatform: "win32",
      environment: {},
    }),
    /WINDOWS_CERTIFICATE_THUMBPRINT/,
  );
  assert.throws(
    () => createTauriBuildPlan(["--sign"], {
      ...planOptions,
      hostPlatform: "darwin",
    }),
    /only for Windows builds/,
  );
});

test("build entry rejects unknown hosts, targets, duplicate options, and direct invocation", () => {
  assert.throws(
    () => createTauriBuildPlan([], { ...planOptions, hostPlatform: "linux" }),
    /Unsupported preparation platform: linux/,
  );
  assert.throws(
    () => createTauriBuildPlan(["--target", "unknown-target"], planOptions),
    /Unsupported Tauri target: unknown-target/,
  );
  assert.throws(
    () => createTauriBuildPlan(["--dry-run", "--dry-run"], planOptions),
    /--dry-run option may only be specified once/,
  );
  assert.throws(
    () => createTauriBuildPlan(["--sign", "--sign"], planOptions),
    /--sign option may only be specified once/,
  );
  assert.throws(
    () => createTauriBuildPlan([], { ...planOptions, npmCliPath: "", hostPlatform: "darwin" }),
    /must be started through an npm script/,
  );
});

test("build execution uses argument arrays, injects CI, and stops after failure", () => {
  const plan = createTauriBuildPlan(["--target", "x86_64-pc-windows-msvc"], planOptions);
  const calls = [];
  assert.throws(
    () => executeTauriBuildPlan(plan, {
      environment: { PATH: "/reviewed/bin", CI: "caller-value" },
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        return { status: calls.length === 1 ? 0 : 23 };
      },
    }),
    /tauri-build exited with status 23/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.CI, "caller-value");
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.env.CI, "true");
});

test("CI workflows call explicit platform prepare entries", () => {
  assert.match(checkWorkflow, /npm run app:prepare:macos/);
  assert.match(checkWorkflow, /npm run app:prepare:windows/);
  assert.match(releaseWorkflow, /npm run app:prepare:macos/);
});
