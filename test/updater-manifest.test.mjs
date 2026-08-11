import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createUpdaterManifest,
  DARWIN_UPDATER_PLATFORMS,
  RELEASE_UPDATER_PLATFORMS,
  updaterArtifactUrl,
  WINDOWS_UPDATER_PLATFORMS,
} from "../scripts/updater-manifest.mjs";

const macProducerSource = await readFile(
  new URL("../scripts/create-macos-updater.mjs", import.meta.url),
  "utf8",
);
const macVerifierSource = await readFile(
  new URL("../scripts/verify-macos-release.mjs", import.meta.url),
  "utf8",
);
const windowsProducerSource = await readFile(
  new URL("../scripts/create-windows-updater.mjs", import.meta.url),
  "utf8",
);
const macReleaseWorkflow = await readFile(
  new URL("../.github/workflows/release-macos.yml", import.meta.url),
  "utf8",
);

function signatureEnvelope(fill) {
  const signatureRecord = Buffer.alloc(74, fill);
  signatureRecord.write("ED", 0, "ascii");
  const globalSignature = Buffer.alloc(64, fill + 1);
  return Buffer.from([
    "untrusted comment: fixture signature",
    signatureRecord.toString("base64"),
    "trusted comment: timestamp:0",
    globalSignature.toString("base64"),
  ].join("\n")).toString("base64");
}

function fragment(platforms, { version = "0.2.2", fill = 1 } = {}) {
  const signature = signatureEnvelope(fill);
  return {
    schemaVersion: 1,
    version,
    platforms: Object.fromEntries(platforms.map((platform) => {
      const artifact = `${platform}.artifact`;
      return [platform, {
        artifact,
        signature,
        url: updaterArtifactUrl(version, artifact),
      }];
    })),
  };
}

test("cross-platform latest.json contains exactly the reviewed Darwin and Windows keys", () => {
  const manifest = createUpdaterManifest({
    fragments: [
      fragment(DARWIN_UPDATER_PLATFORMS),
      fragment(WINDOWS_UPDATER_PLATFORMS, { fill: 4 }),
    ],
    expectedVersion: "0.2.2",
    pubDate: "2026-08-12T00:00:00.000Z",
  });
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [...RELEASE_UPDATER_PLATFORMS].sort());
  assert.equal(manifest.version, "0.2.2");
  assert.equal(manifest.pub_date, "2026-08-12T00:00:00.000Z");
  for (const entry of Object.values(manifest.platforms)) {
    assert.deepEqual(Object.keys(entry).sort(), ["signature", "url"]);
  }
});

test("manifest merger rejects missing, duplicate, wrong-version, unsafe and malformed entries", () => {
  const darwin = fragment(DARWIN_UPDATER_PLATFORMS);
  const windows = fragment(WINDOWS_UPDATER_PLATFORMS, { fill: 4 });
  assert.throws(
    () => createUpdaterManifest({ fragments: [darwin], expectedVersion: "0.2.2" }),
    /platform set is incomplete/,
  );
  assert.throws(
    () => createUpdaterManifest({
      fragments: [darwin, windows, windows],
      expectedVersion: "0.2.2",
    }),
    /Duplicate updater platform/,
  );
  assert.throws(
    () => createUpdaterManifest({
      fragments: [darwin, fragment(WINDOWS_UPDATER_PLATFORMS, { version: "0.2.1" })],
      expectedVersion: "0.2.2",
    }),
    /version is incorrect/,
  );

  const unsafe = structuredClone(windows);
  unsafe.platforms["windows-x86_64"].artifact = "../setup.exe";
  assert.throws(
    () => createUpdaterManifest({ fragments: [darwin, unsafe], expectedVersion: "0.2.2" }),
    /artifact name is unsafe/,
  );
  const malformed = structuredClone(windows);
  malformed.platforms["windows-x86_64"].signature = "not-minisign";
  assert.throws(
    () => createUpdaterManifest({ fragments: [darwin, malformed], expectedVersion: "0.2.2" }),
    /did not match|not a Tauri minisign envelope/,
  );
  assert.throws(
    () => createUpdaterManifest({
      fragments: [darwin, windows],
      expectedVersion: "0.2.2",
      pubDate: "not-a-date",
    }),
    /Invalid time value|pub_date/,
  );
});

test("Darwin and Windows producers use the shared fragment contract", () => {
  assert.match(macProducerSource, /DARWIN_UPDATER_PLATFORMS/);
  assert.match(macProducerSource, /darwin-updater\.json/);
  assert.match(macProducerSource, /createUpdaterManifest/);
  assert.match(macVerifierSource, /windows-updater\.json/);
  assert.match(macVerifierSource, /latest\.json does not match the verified updater fragments/);
  assert.match(
    macVerifierSource,
    /const expectedPlatforms = \[\.\.\.requiredPlatforms\]/,
    "release verification must not sort the frozen platform policy in place",
  );
  const fragmentMentions = macReleaseWorkflow.match(/darwin-updater\.json/g) ?? [];
  assert.ok(
    fragmentMentions.length >= 3,
    "macOS release must copy, hash, upload, and remotely verify the Darwin fragment",
  );
  assert.match(windowsProducerSource, /WINDOWS_UPDATER_PLATFORMS/);
  assert.match(windowsProducerSource, /validateUpdaterFragment/);
  assert.doesNotMatch(windowsProducerSource, /latest\.json/);
});
