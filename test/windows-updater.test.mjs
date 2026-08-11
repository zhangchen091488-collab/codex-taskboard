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

import { prepareWindowsUpdaterAsset } from "../scripts/create-windows-updater.mjs";

function minisignFixture(artifact) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const keyId = randomBytes(8);
  const publicRecord = Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]);
  const digest = createHash("blake2b512").update(artifact).digest();
  const fileSignature = sign(null, digest, privateKey);
  const signatureRecord = Buffer.concat([Buffer.from("ED"), keyId, fileSignature]);
  const trustedComment = Buffer.from("timestamp:0");
  const globalSignature = sign(
    null,
    Buffer.concat([fileSignature, trustedComment]),
    privateKey,
  );
  const publicEnvelope = [
    "untrusted comment: fixture public key",
    publicRecord.toString("base64"),
  ].join("\n");
  const signatureEnvelope = [
    "untrusted comment: fixture signature",
    signatureRecord.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
  ].join("\n");
  return {
    publicKey: Buffer.from(publicEnvelope).toString("base64"),
    signature: Buffer.from(signatureEnvelope).toString("base64"),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows-updater-"));
  const installerPath = path.join(root, "Codex Taskboard_0.2.2_x64-setup.exe");
  const artifact = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(128, 7)]);
  const signing = minisignFixture(artifact);
  await writeFile(installerPath, artifact);
  await writeFile(`${installerPath}.sig`, signing.signature);
  return { root, installerPath, artifact, ...signing };
}

test("Windows updater stages the verified Tauri v2 NSIS executable and metadata", async () => {
  const testFixture = await fixture();
  try {
    const outputDirectory = path.join(testFixture.root, "release");
    const metadata = await prepareWindowsUpdaterAsset({
      installerPath: testFixture.installerPath,
      signaturePath: `${testFixture.installerPath}.sig`,
      outputDirectory,
      releaseTag: "v0.2.2",
      expectedVersion: "0.2.2",
      publicKey: testFixture.publicKey,
    });
    assert.deepEqual(metadata, JSON.parse(await readFile(
      path.join(outputDirectory, "windows-updater.json"),
      "utf8",
    )));
    assert.deepEqual(
      await readFile(path.join(outputDirectory, metadata.artifact)),
      testFixture.artifact,
    );
    assert.equal(metadata.target, "windows-x86_64");
    assert.match(metadata.url, /\/v0\.2\.2\/Codex\.Taskboard_0\.2\.2_x64-setup\.exe$/);
  } finally {
    await rm(testFixture.root, { recursive: true, force: true });
  }
});

test("Windows updater rejects wrong signatures, tampering, and version mismatch", async (t) => {
  await t.test("different key", async () => {
    const testFixture = await fixture();
    try {
      const otherSigning = minisignFixture(testFixture.artifact);
      await assert.rejects(
        prepareWindowsUpdaterAsset({
          installerPath: testFixture.installerPath,
          signaturePath: `${testFixture.installerPath}.sig`,
          outputDirectory: path.join(testFixture.root, "wrong-key"),
          releaseTag: "v0.2.2",
          expectedVersion: "0.2.2",
          publicKey: otherSigning.publicKey,
        }),
        /different key/,
      );
    } finally {
      await rm(testFixture.root, { recursive: true, force: true });
    }
  });

  await t.test("tampered installer", async () => {
    const testFixture = await fixture();
    try {
      await writeFile(testFixture.installerPath, Buffer.concat([
        testFixture.artifact,
        Buffer.from("tampered"),
      ]));
      await assert.rejects(
        prepareWindowsUpdaterAsset({
          installerPath: testFixture.installerPath,
          signaturePath: `${testFixture.installerPath}.sig`,
          outputDirectory: path.join(testFixture.root, "tampered"),
          releaseTag: "v0.2.2",
          expectedVersion: "0.2.2",
          publicKey: testFixture.publicKey,
        }),
        /signature verification failed/,
      );
    } finally {
      await rm(testFixture.root, { recursive: true, force: true });
    }
  });

  await t.test("version mismatch", async () => {
    const testFixture = await fixture();
    try {
      await assert.rejects(
        prepareWindowsUpdaterAsset({
          installerPath: testFixture.installerPath,
          signaturePath: `${testFixture.installerPath}.sig`,
          outputDirectory: path.join(testFixture.root, "version"),
          releaseTag: "v0.2.1",
          expectedVersion: "0.2.2",
          publicKey: testFixture.publicKey,
        }),
        /does not match/,
      );
    } finally {
      await rm(testFixture.root, { recursive: true, force: true });
    }
  });

  await t.test("partial staging rollback", async () => {
    const testFixture = await fixture();
    try {
      const outputDirectory = path.join(testFixture.root, "collision");
      const artifactName = "Codex.Taskboard_0.2.2_x64-setup.exe";
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(`${path.join(outputDirectory, artifactName)}.sig`, "occupied", {
        flag: "wx",
      });
      await assert.rejects(
        prepareWindowsUpdaterAsset({
          installerPath: testFixture.installerPath,
          signaturePath: `${testFixture.installerPath}.sig`,
          outputDirectory,
          releaseTag: "v0.2.2",
          expectedVersion: "0.2.2",
          publicKey: testFixture.publicKey,
        }),
        /EEXIST/,
      );
      await assert.rejects(
        access(path.join(outputDirectory, artifactName)),
        /ENOENT/,
      );
      assert.equal(
        await readFile(`${path.join(outputDirectory, artifactName)}.sig`, "utf8"),
        "occupied",
      );
    } finally {
      await rm(testFixture.root, { recursive: true, force: true });
    }
  });
});
