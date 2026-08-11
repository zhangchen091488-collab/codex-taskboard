import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createUpdaterManifest,
  DARWIN_UPDATER_PLATFORMS,
  updaterArtifactUrl,
  WINDOWS_UPDATER_PLATFORMS,
} from "../scripts/updater-manifest.mjs";
import { verifyReleaseUpdaterAssets } from "../scripts/verify-release-updater.mjs";

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
      const signatureRecord = Buffer.concat([Buffer.from("ED"), keyId, fileSignature]);
      const trustedComment = Buffer.from("timestamp:0");
      const globalSignature = sign(
        null,
        Buffer.concat([fileSignature, trustedComment]),
        privateKey,
      );
      return Buffer.from([
        "untrusted comment: fixture signature",
        signatureRecord.toString("base64"),
        `trusted comment: ${trustedComment}`,
        globalSignature.toString("base64"),
      ].join("\n")).toString("base64");
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-updater-"));
  const version = "0.2.2";
  const macArtifact = `Codex.Taskboard_${version}_universal.app.tar.gz`;
  const windowsArtifact = `Codex.Taskboard_${version}_x64-setup.exe`;
  const macBytes = Buffer.from("mac updater fixture");
  const windowsBytes = Buffer.concat([Buffer.from("MZ"), Buffer.from("windows fixture")]);
  const signing = signer();
  const macSignature = signing.signature(macBytes);
  const windowsSignature = signing.signature(windowsBytes);
  const darwin = {
    schemaVersion: 1,
    version,
    platforms: Object.fromEntries(DARWIN_UPDATER_PLATFORMS.map((platform) => [platform, {
      artifact: macArtifact,
      signature: macSignature,
      url: updaterArtifactUrl(version, macArtifact),
    }])),
  };
  const windows = {
    schemaVersion: 1,
    version,
    platforms: Object.fromEntries(WINDOWS_UPDATER_PLATFORMS.map((platform) => [platform, {
      artifact: windowsArtifact,
      signature: windowsSignature,
      url: updaterArtifactUrl(version, windowsArtifact),
    }])),
  };
  const latest = createUpdaterManifest({
    fragments: [darwin, windows],
    expectedVersion: version,
    pubDate: "2026-08-12T00:00:00.000Z",
  });
  await Promise.all([
    writeFile(path.join(root, macArtifact), macBytes),
    writeFile(path.join(root, `${macArtifact}.sig`), `${macSignature}\n`),
    writeFile(path.join(root, windowsArtifact), windowsBytes),
    writeFile(path.join(root, `${windowsArtifact}.sig`), `${windowsSignature}\n`),
    writeFile(path.join(root, "darwin-updater.json"), JSON.stringify(darwin)),
    writeFile(path.join(root, "windows-updater.json"), JSON.stringify(windows)),
    writeFile(path.join(root, "latest.json"), JSON.stringify(latest)),
  ]);
  return { root, version, windowsArtifact, publicKey: signing.publicKey };
}

test("final updater verifier checks the exact merged manifest and both signed artifacts", async () => {
  const value = await fixture();
  try {
    const result = await verifyReleaseUpdaterAssets({
      releaseDirectory: value.root,
      expectedVersion: value.version,
      publicKey: value.publicKey,
    });
    assert.equal(result.platforms.length, 7);
    assert.equal(result.artifacts.length, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("final updater verifier rejects manifest drift, detached signature drift and tampering", async (t) => {
  await t.test("manifest drift", async () => {
    const value = await fixture();
    try {
      const latestPath = path.join(value.root, "latest.json");
      const latest = JSON.parse(await readFile(latestPath, "utf8"));
      latest.notes = "changed";
      await writeFile(latestPath, JSON.stringify(latest));
      await assert.rejects(
        verifyReleaseUpdaterAssets({
          releaseDirectory: value.root,
          expectedVersion: value.version,
          publicKey: value.publicKey,
        }),
        /does not match/,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("detached signature drift", async () => {
    const value = await fixture();
    try {
      await writeFile(path.join(value.root, `${value.windowsArtifact}.sig`), "different\n");
      await assert.rejects(
        verifyReleaseUpdaterAssets({
          releaseDirectory: value.root,
          expectedVersion: value.version,
          publicKey: value.publicKey,
        }),
        /does not match its updater fragment/,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  await t.test("artifact tampering", async () => {
    const value = await fixture();
    try {
      await writeFile(path.join(value.root, value.windowsArtifact), "MZtampered");
      await assert.rejects(
        verifyReleaseUpdaterAssets({
          releaseDirectory: value.root,
          expectedVersion: value.version,
          publicKey: value.publicKey,
        }),
        /signature verification failed/,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
