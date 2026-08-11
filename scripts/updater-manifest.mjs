import assert from "node:assert/strict";

export const DARWIN_UPDATER_PLATFORMS = Object.freeze([
  "darwin-aarch64",
  "darwin-x86_64",
  "darwin-universal",
  "darwin-aarch64-app",
  "darwin-x86_64-app",
  "darwin-universal-app",
]);
export const WINDOWS_UPDATER_PLATFORMS = Object.freeze(["windows-x86_64"]);
export const RELEASE_UPDATER_PLATFORMS = Object.freeze([
  ...DARWIN_UPDATER_PLATFORMS,
  ...WINDOWS_UPDATER_PLATFORMS,
]);

const repositoryUrl = "https://github.com/chuspeeism/dashi-taskboard";

function assertSignatureEnvelope(signature, platform) {
  assert.equal(typeof signature, "string", `${platform} signature must be a string`);
  assert.match(signature.trim(), /^[A-Za-z0-9+/]+={0,2}$/);
  const decoded = Buffer.from(signature.trim(), "base64").toString("utf8");
  const lines = decoded.trim().split("\n");
  assert.equal(lines.length, 4, `${platform} signature envelope is invalid`);
  assert.ok(
    lines[0]?.startsWith("untrusted comment: "),
    `${platform} signature is not a Tauri minisign envelope`,
  );
  const signatureRecord = Buffer.from(lines[1] ?? "", "base64");
  assert.equal(
    signatureRecord.length,
    74,
    `${platform} signature record is invalid`,
  );
  assert.equal(
    signatureRecord.subarray(0, 2).toString("ascii"),
    "ED",
    `${platform} signature must use prehashed minisign`,
  );
  assert.ok(
    lines[2]?.startsWith("trusted comment: "),
    `${platform} signature trusted comment is invalid`,
  );
  assert.equal(
    Buffer.from(lines[3] ?? "", "base64").length,
    64,
    `${platform} global signature is invalid`,
  );
}

function expectedArtifactUrl(version, artifact) {
  return `${repositoryUrl}/releases/download/v${version}/${encodeURIComponent(artifact)}`;
}

export function validateUpdaterFragment(fragment, {
  expectedVersion,
  allowedPlatforms = RELEASE_UPDATER_PLATFORMS,
} = {}) {
  assert.equal(fragment?.schemaVersion, 1, "Updater fragment schema is unsupported");
  assert.equal(fragment?.version, expectedVersion, "Updater fragment version is incorrect");
  assert.ok(
    fragment.platforms
      && typeof fragment.platforms === "object"
      && !Array.isArray(fragment.platforms),
    "Updater fragment platforms must be an object",
  );
  const platformNames = Object.keys(fragment.platforms);
  assert.ok(platformNames.length > 0, "Updater fragment has no platforms");
  for (const platform of platformNames) {
    assert.ok(allowedPlatforms.includes(platform), `Unexpected updater platform: ${platform}`);
    const entry = fragment.platforms[platform];
    assert.deepEqual(
      Object.keys(entry ?? {}).sort(),
      ["artifact", "signature", "url"],
      `${platform} updater entry has unexpected fields`,
    );
    assert.equal(typeof entry.artifact, "string", `${platform} artifact must be a string`);
    assert.equal(pathSafeArtifact(entry.artifact), true, `${platform} artifact name is unsafe`);
    assert.equal(
      entry.url,
      expectedArtifactUrl(expectedVersion, entry.artifact),
      `${platform} updater URL is incorrect`,
    );
    assertSignatureEnvelope(entry.signature, platform);
  }
  return fragment;
}

function pathSafeArtifact(artifact) {
  return typeof artifact === "string" && /^[A-Za-z0-9._-]+$/.test(artifact);
}

export function createUpdaterManifest({
  fragments,
  expectedVersion,
  requiredPlatforms = RELEASE_UPDATER_PLATFORMS,
  pubDate = new Date().toISOString(),
}) {
  assert.ok(Array.isArray(fragments) && fragments.length > 0, "Updater fragments are required");
  const platforms = {};
  for (const fragment of fragments) {
    validateUpdaterFragment(fragment, { expectedVersion, allowedPlatforms: requiredPlatforms });
    for (const [platform, entry] of Object.entries(fragment.platforms)) {
      assert.equal(
        Object.hasOwn(platforms, platform),
        false,
        `Duplicate updater platform: ${platform}`,
      );
      platforms[platform] = {
        signature: entry.signature,
        url: entry.url,
      };
    }
  }

  const actualPlatforms = Object.keys(platforms).sort();
  const expectedPlatforms = [...requiredPlatforms].sort();
  assert.deepEqual(actualPlatforms, expectedPlatforms, "Updater platform set is incomplete");
  assert.equal(new Date(pubDate).toISOString(), pubDate, "Updater pub_date must be RFC 3339 UTC");
  return {
    version: expectedVersion,
    notes: `Codex Taskboard ${expectedVersion}`,
    pub_date: pubDate,
    platforms,
  };
}

export function updaterArtifactUrl(version, artifact) {
  assert.equal(pathSafeArtifact(artifact), true, "Updater artifact name is unsafe");
  return expectedArtifactUrl(version, artifact);
}
