import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import { windowsTaskctlWrapper } from "../scripts/prepare-tauri-app.mjs";
import { verifyWindowsResources } from "../scripts/verify-windows-resources.mjs";

const selectedScripts = [
  "codex-cdp-pipe.mjs",
  "codex-injector-discovery.mjs",
  "codex-injector.mjs",
  "codex-injector-runtime.mjs",
  "codex-rate-limits.mjs",
  "taskboard-supervisor.mjs",
];

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function writeFixtureFile(root, relativePath, contents = relativePath) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

function x64PeFixture() {
  const contents = Buffer.alloc(128);
  contents.write("MZ", 0, "ascii");
  contents.writeUInt32LE(64, 0x3c);
  contents.write("PE\u0000\u0000", 64, "binary");
  contents.writeUInt16LE(0x8664, 68);
  return contents;
}

function icoFixture() {
  const sizes = [32, 16, 24, 48, 64, 256];
  const directoryLength = 6 + sizes.length * 16;
  const contents = Buffer.alloc(directoryLength + sizes.length);
  contents.writeUInt16LE(0, 0);
  contents.writeUInt16LE(1, 2);
  contents.writeUInt16LE(sizes.length, 4);
  sizes.forEach((size, index) => {
    const offset = 6 + index * 16;
    contents[offset] = size === 256 ? 0 : size;
    contents[offset + 1] = size === 256 ? 0 : size;
    contents.writeUInt16LE(32, offset + 6);
    contents.writeUInt32LE(1, offset + 8);
    contents.writeUInt32LE(directoryLength + index, offset + 12);
    contents[directoryLength + index] = index + 1;
  });
  return contents;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-windows-resources-"));
  const projectRoot = path.join(root, "project");
  const tauriRoot = path.join(projectRoot, "src-tauri");
  const resourcesRoot = path.join(tauriRoot, "resources");
  const appRoot = path.join(resourcesRoot, "app");

  for (const relativePath of ["server/index.mjs", "server/app.mjs"]) {
    await writeFixtureFile(projectRoot, relativePath);
  }
  await writeFixtureFile(projectRoot, "shared/platform-runtime.mjs");
  await writeFixtureFile(projectRoot, "dist/web/index.html");
  await writeFixtureFile(projectRoot, "dist/web/assets/app.js");
  await writeFixtureFile(projectRoot, "skills/manage-taskboard/SKILL.md");
  await writeFixtureFile(projectRoot, "skills/manage-taskboard/references/cli.md");
  await writeFixtureFile(projectRoot, "skills/manage-taskboard/agents/openai.yaml");
  for (const fileName of selectedScripts) {
    await writeFixtureFile(projectRoot, path.join("scripts", fileName));
  }
  await writeFixtureFile(projectRoot, "inject/codex-taskboard.user.js");
  await writeFixtureFile(projectRoot, "cli/taskctl.mjs");
  const lobeLicense = await writeFixtureFile(
    tauriRoot,
    "licenses/Lobe-Icons-LICENSE.txt",
    "reviewed Lobe license",
  );

  for (const [source, destination] of [
    ["server", "server"],
    ["shared", "shared"],
    ["dist/web", "dist/web"],
    ["skills/manage-taskboard", "skills/manage-taskboard"],
  ]) {
    await cp(path.join(projectRoot, source), path.join(appRoot, destination), { recursive: true });
  }
  for (const fileName of selectedScripts) {
    await writeFixtureFile(
      appRoot,
      path.join("scripts", fileName),
      await readFile(path.join(projectRoot, "scripts", fileName)),
    );
  }
  await cp(
    path.join(projectRoot, "inject/codex-taskboard.user.js"),
    path.join(appRoot, "inject/codex-taskboard.user.js"),
  );
  await cp(path.join(projectRoot, "cli/taskctl.mjs"), path.join(appRoot, "cli/taskctl.mjs"));
  await writeFixtureFile(resourcesRoot, "bin/taskctl.cmd", windowsTaskctlWrapper());
  await cp(lobeLicense, path.join(resourcesRoot, "licenses/Lobe-Icons-LICENSE.txt"));

  const nodeLicense = Buffer.from("reviewed Node license");
  const sidecar = x64PeFixture();
  const icon = icoFixture();
  await writeFixtureFile(resourcesRoot, "licenses/Node-LICENSE", nodeLicense);
  await writeFixtureFile(
    tauriRoot,
    "binaries/node-x86_64-pc-windows-msvc.exe",
    sidecar,
  );
  await writeFixtureFile(tauriRoot, "icons/icon.ico", icon);

  return {
    root,
    projectRoot,
    tauriRoot,
    resourcesRoot,
    appRoot,
    expectations: {
      nodeExecutableSha256: sha256(sidecar),
      nodeLicenseSha256: sha256(nodeLicense),
      iconSha256: sha256(icon),
    },
  };
}

test("Windows resource verifier accepts a complete staged tree without modifying it", async () => {
  const fixture = await createFixture();
  try {
    const result = await verifyWindowsResources(fixture);
    assert.equal(result.target, "x86_64-pc-windows-msvc");
    assert.equal(result.mirroredFileCount, 8);
    assert.equal(result.sidecarSha256, fixture.expectations.nodeExecutableSha256);
    assert.equal(result.iconSha256, fixture.expectations.iconSha256);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Windows resource verifier rejects deleted, tampered, and forbidden staging content", async (t) => {
  const mutations = [
    {
      name: "missing sidecar",
      category: /\[sidecar\]/,
      mutate: (fixture) => rm(
        path.join(fixture.tauriRoot, "binaries/node-x86_64-pc-windows-msvc.exe"),
      ),
    },
    {
      name: "tampered application resource",
      category: /\[application resources\]/,
      mutate: (fixture) => writeFile(path.join(fixture.appRoot, "server/index.mjs"), "tampered"),
    },
    {
      name: "missing skill file",
      category: /\[skill\]/,
      mutate: (fixture) => rm(path.join(fixture.appRoot, "skills/manage-taskboard/SKILL.md")),
    },
    {
      name: "tampered CLI",
      category: /\[CLI\]/,
      mutate: (fixture) => writeFile(path.join(fixture.appRoot, "cli/taskctl.mjs"), "tampered"),
    },
    {
      name: "missing license",
      category: /\[licenses\]/,
      mutate: (fixture) => rm(path.join(fixture.resourcesRoot, "licenses/Node-LICENSE")),
    },
    {
      name: "tampered icon",
      category: /\[icon\]/,
      mutate: (fixture) => writeFile(path.join(fixture.tauriRoot, "icons/icon.ico"), "tampered"),
    },
    {
      name: "forbidden environment file",
      category: /\[forbidden files\]/,
      mutate: (fixture) => writeFixtureFile(fixture.appRoot, "server/.env.production", "secret"),
    },
    {
      name: "empty forbidden dependency directory",
      category: /\[forbidden files\]/,
      mutate: (fixture) => mkdir(path.join(fixture.appRoot, "server/node_modules")),
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const fixture = await createFixture();
      try {
        await mutation.mutate(fixture);
        await assert.rejects(verifyWindowsResources(fixture), mutation.category);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});
