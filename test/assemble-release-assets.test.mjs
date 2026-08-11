import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assembleReleaseAssets } from "../scripts/assemble-release-assets.mjs";
import {
  createUpdaterManifest,
  DARWIN_UPDATER_PLATFORMS,
  updaterArtifactUrl,
  WINDOWS_UPDATER_PLATFORMS,
} from "../scripts/updater-manifest.mjs";

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const keyId = randomBytes(8);
  const publicRecord = Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]);
  return {
    publicKey: Buffer.from([
      "untrusted comment: fixture public key",
      publicRecord.toString("base64"),
    ].join("\n")).toString("base64"),
    signature(artifact) {
      const digest = createHash("blake2b512").update(artifact).digest();
      const fileSignature = sign(null, digest, privateKey);
      const record = Buffer.concat([Buffer.from("ED"), keyId, fileSignature]);
      const trustedComment = Buffer.from("timestamp:0");
      const globalSignature = sign(
        null,
        Buffer.concat([fileSignature, trustedComment]),
        privateKey,
      );
      return Buffer.from([
        "untrusted comment: fixture signature",
        record.toString("base64"),
        `trusted comment: ${trustedComment}`,
        globalSignature.toString("base64"),
      ].join("\n")).toString("base64");
    },
  };
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-assembly-"));
  const macDirectory = path.join(root, "mac");
  const windowsDirectory = path.join(root, "windows");
  await Promise.all([mkdir(macDirectory), mkdir(windowsDirectory)]);
  const version = "0.2.2";
  const macArchive = `Codex.Taskboard_${version}_universal.app.tar.gz`;
  const macDmg = `Codex.Taskboard_${version}_universal.dmg`;
  const windowsSetup = `Codex.Taskboard_${version}_x64-setup.exe`;
  const macBytes = Buffer.from("mac archive");
  const windowsBytes = Buffer.concat([Buffer.from("MZ"), Buffer.from("windows setup")]);
  const signing = signer();
  const macSignature = signing.signature(macBytes);
  const windowsSignature = signing.signature(windowsBytes);
  const darwin = {
    schemaVersion: 1,
    version,
    platforms: Object.fromEntries(DARWIN_UPDATER_PLATFORMS.map((platform) => [platform, {
      artifact: macArchive,
      signature: macSignature,
      url: updaterArtifactUrl(version, macArchive),
    }])),
  };
  const windows = {
    schemaVersion: 1,
    version,
    platforms: Object.fromEntries(WINDOWS_UPDATER_PLATFORMS.map((platform) => [platform, {
      artifact: windowsSetup,
      signature: windowsSignature,
      url: updaterArtifactUrl(version, windowsSetup),
    }])),
  };
  const latest = createUpdaterManifest({
    fragments: [darwin],
    expectedVersion: version,
    requiredPlatforms: DARWIN_UPDATER_PLATFORMS,
    pubDate: "2026-08-12T00:00:00.000Z",
  });
  await Promise.all([
    writeFile(path.join(macDirectory, macDmg), "dmg"),
    writeFile(path.join(macDirectory, macArchive), macBytes),
    writeFile(path.join(macDirectory, `${macArchive}.sig`), `${macSignature}\n`),
    writeFile(path.join(macDirectory, "darwin-updater.json"), JSON.stringify(darwin)),
    writeFile(path.join(macDirectory, "latest.json"), JSON.stringify(latest)),
    writeFile(path.join(windowsDirectory, windowsSetup), windowsBytes),
    writeFile(path.join(windowsDirectory, `${windowsSetup}.sig`), `${windowsSignature}\n`),
    writeFile(path.join(windowsDirectory, "windows-updater.json"), JSON.stringify(windows)),
  ]);
  const macNames = [macDmg, macArchive, `${macArchive}.sig`, "darwin-updater.json", "latest.json"];
  const macManifestPath = path.join(root, "mac.sha256");
  const records = [];
  for (const name of macNames) {
    records.push(`${await sha256(path.join(macDirectory, name))}  ${name}`);
  }
  await writeFile(macManifestPath, `${records.join("\n")}\n`);
  return {
    root,
    version,
    expectedVersion: version,
    macDirectory,
    windowsDirectory,
    macManifestPath,
    outputDirectory: path.join(root, "release"),
    outputManifestPath: path.join(root, "release.sha256"),
    publicKey: signing.publicKey,
    macDmg,
  };
}

test("release assembly verifies the macOS baseline and creates an exact signed cross-platform set", async () => {
  const value = await fixture();
  try {
    const result = await assembleReleaseAssets(value);
    assert.equal(result.assets.length, 8);
    assert.equal(result.updater.platforms.length, 7);
    assert.equal((await readFile(value.outputManifestPath, "utf8")).trim().split("\n").length, 8);
    const latest = JSON.parse(await readFile(path.join(value.outputDirectory, "latest.json"), "utf8"));
    assert.equal(latest.pub_date, "2026-08-12T00:00:00.000Z");
    assert.deepEqual(Object.keys(latest.platforms).sort(), result.updater.platforms);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("release assembly fails closed and rolls back only its new output", async (t) => {
  await t.test("trusted macOS digest mismatch", async () => {
    const value = await fixture();
    try {
      await writeFile(path.join(value.macDirectory, value.macDmg), "changed");
      await assert.rejects(assembleReleaseAssets(value), /SHA-256 mismatch/);
      await assert.rejects(access(value.outputDirectory), /ENOENT/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("unexpected Windows asset", async () => {
    const value = await fixture();
    try {
      await writeFile(path.join(value.windowsDirectory, "extra.exe"), "MZ");
      await assert.rejects(assembleReleaseAssets(value), /Windows release staging is incorrect/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("pre-existing output is preserved", async () => {
    const value = await fixture();
    try {
      await mkdir(value.outputDirectory);
      const marker = path.join(value.outputDirectory, "owned-by-caller");
      await writeFile(marker, "keep");
      await assert.rejects(assembleReleaseAssets(value), /EEXIST/);
      assert.equal(await readFile(marker, "utf8"), "keep");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("output cannot be nested in a trusted input", async () => {
    const value = await fixture();
    try {
      value.outputDirectory = path.join(value.macDirectory, "release");
      await assert.rejects(assembleReleaseAssets(value), /outside the macOS baseline/);
      assert.deepEqual(
        (await readFile(path.join(value.macDirectory, value.macDmg), "utf8")),
        "dmg",
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
