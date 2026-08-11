# Windows release readiness audit

## Decision

**NO-GO for a production Windows release.**

The `windows-adapter` branch contains the Windows launcher, packaging, signing,
updater, CI, evidence collection and user-documentation code needed to start
real Windows validation. It does not yet contain the protected GitHub workflow
that uploads Windows assets to the shared Draft Release and replaces the
reviewed Darwin-only `latest.json`. That remote-write implementation requires
explicit authorization. No production Windows runner, certificate or VM result
has been substituted with macOS static checks.

This audit permits local development and controlled Windows validation only. It
does not authorize pushing the branch, creating tags, uploading artifacts,
editing a Draft Release or publishing a Release.

## Evidence completed locally

- Cross-platform process execution, paths, profile isolation, private CDP pipe,
  Windows Job Object lifecycle, launcher recovery and shutdown contracts are
  implemented and covered by Node/Rust tests.
- The Windows resource build includes Node.js 22.23.2, `taskctl.cmd`, the server,
  injector and Web UI. The Node archive and executable have pinned SHA-256
  values and the PE architecture is checked.
- Tauri Windows configuration is current-user NSIS, Windows 11 x64,
  `downloadBootstrapper` WebView2 and `allowDowngrades: false`.
- Protected signing helpers import exactly one non-exportable code-signing
  certificate, pass only its public thumbprint/timestamp policy to Tauri,
  require exact signer subject and timestamp, test a tampered copy and clean up
  the exact certificate.
- Tauri v2 updater staging verifies the setup `.sig`; the cross-platform
  assembler verifies the trusted macOS five-asset baseline and creates an exact
  eight-asset set with a new SHA-256 manifest.
- macOS regression on 2026-08-12 passed fixed Node 22.23.2 typecheck, Web build,
  the complete Node suite, isolated iframe test, Rust 1.88 tests (44/44), Rust
  check, unsigned universal App/DMG build, packaged `taskctl`, secretless
  updater/DMG preflight and packaged resource comparison.
- Windows installation, data/log paths, packaged `taskctl`, update recovery and
  read-only diagnostics are documented in `docs/windows-installation.md`.
- The deferred runtime gate now has create-only sanitized environment,
  transport and production cleanup collectors, a strict six-file verifier, an
  isolated three-transport probe and the local-only sequence in
  `docs/windows-runtime-validation.md`. These tools do not replace actual
  Windows execution.

Key local commits for the final delivery slice:

| Commit | Evidence |
| --- | --- |
| `602ae1f` | CI builds, installs, byte-verifies and uninstalls a real unsigned NSIS |
| `37632e0` | Windows common Node/typecheck/Web CI |
| `e135b00` | Cross-platform fixture contract |
| `cc37c78` | Seven-stage Windows install/update/uninstall matrix verifier |
| `0da4d1a` | Combined updater manifest and cryptographic asset verifier |
| `aa0be91` | Authenticode tamper rejection on an isolated copy |
| `e0768c0` | Exact signed Windows release staging verifier |
| `fb92cb4` | Trusted cross-platform eight-asset assembly and SHA-256 manifest |
| `56c863f` | Windows install/troubleshooting guide and documentation tests |
| `cc46659` | Sanitized six-file Windows runtime evidence contract and verifier |
| `1214318` | Windows environment and production evidence collectors |
| `97c60ad` | Disposable-profile dynamic-port, fixed-port and private-pipe probe |
| `0b21a7b` | Attainable injection evidence and explicit cleanup-scenario confirmation |
| `d3d18d1` | No-remote-desktop Windows runtime validation runbook |

## Production blockers

| Severity | Blocker | Required evidence / owner |
| --- | --- | --- |
| P0 | Protected Windows release workflow is not integrated | User explicitly authorizes code that uploads signed setup, `.sig` and `windows-updater.json` to the shared Draft and replaces only a still-trusted Darwin-only `latest.json`; engineering then implements and audits the atomic Windows job plus unique promotion |
| P0 | Windows runtime has not run on Windows 11 x64 | User runs the common CI, Rust target tests, launcher lifecycle, private pipe, Codex discovery/profile and full Node suite on Windows and returns logs/results |
| P0 | Signed NSIS/updater matrix has no real certificate evidence | Release owner supplies protected environment values; Windows runner proves exact signer, timestamp, tamper rejection, updater signature and remote bytes |
| P0 | Seven-stage install/update/uninstall matrix is not executed | User runs `docs/windows-vm-validation.md` with signed versions N and N+1 and validates the evidence bundle |
| P1 | Cross-platform final `latest.json` has not been consumed by both real clients | One published test release is parsed/installed by macOS universal and Windows x64 clients using the same immutable manifest |
| P1 | Production macOS signing/notarization was not rerun after final workflow integration | Protected macOS build proves Developer ID, notarization, staple, Team IDs and updater archive/DMG equivalence |
| P1 | Windows user guide has not been followed on a clean VM | A new user installs, invokes packaged taskctl, locates logs, diagnoses one failure and uninstalls without losing data |

## Expected immutable release assets

For version `N`, promotion must see exactly these eight assets and no others:

1. `Codex.Taskboard_N_universal.dmg`
2. `Codex.Taskboard_N_universal.app.tar.gz`
3. `Codex.Taskboard_N_universal.app.tar.gz.sig`
4. `darwin-updater.json`
5. `Codex.Taskboard_N_x64-setup.exe`
6. `Codex.Taskboard_N_x64-setup.exe.sig`
7. `windows-updater.json`
8. `latest.json`

The trusted final manifest must hash all eight. `latest.json` must be rebuilt
from the reviewed Darwin and Windows fragments, contain exactly the six Darwin
keys plus `windows-x86_64`, preserve the reviewed publication timestamp, and
pass cryptographic verification of both updater artifacts. The final promotion
job is the only actor allowed to change `draft: true` to `draft: false`.

## Windows validation handoff

Run in this order; stop at the first unexplained failure and keep the relevant
task blocked.

1. On a clean Windows 11 x64 checkout of the exact branch commit, install Node
   22, Rust 1.88, the MSVC target and Visual Studio Build Tools.
2. Run `npm ci`, `npm run typecheck`, `npm run build:web` and `npm test`.
3. Run the Windows Rust test/check commands and the taskctl wrapper test from
   `.github/workflows/check.yml`.
4. Build unsigned NSIS with `npm run app:build:windows`; let the CI-only verifier
   install, compare bundled bytes/Node version and uninstall it on an ephemeral
   runner. Do not distribute this setup.
5. Execute `docs/windows-runtime-validation.md` on a disposable desktop VM.
   Verify official Codex discovery, disposable profiles, dynamic/fixed CDP
   ports, private pipe, injection, normal exit, abnormal recovery and parent
   exit, then require `npm run app:verify:windows-runtime --
   <evidence-directory>` to return `decision: go`.
6. In the protected signing environment, build signed N and N+1 setup files.
   Require exact Authenticode subject, timestamp, tampered-copy rejection and
   Tauri updater signature verification before installation.
7. Execute all scenarios in `docs/windows-vm-validation.md`; validate with
   `npm run app:verify:windows-vm -- <evidence-directory>`.
8. After the remote-write workflow is explicitly authorized and implemented,
   run a test tag. Confirm the Draft moves only through macOS baseline, trusted
   pre-merge and trusted final states. Re-download and hash all eight assets.
9. Approve promotion only after both real updater clients accept the same final
   manifest and the tag/release protection checks pass.

## Rollback and failure policy

- Before promotion, every failure leaves the GitHub Release as Draft. Do not
  manually publish, delete/recreate the protected tag or patch unknown assets.
- If Windows upload stops after its three assets but before manifest merge, a
  rerun may continue only after all eight pre-merge assets match the trusted
  macOS/final manifests. Any other set requires investigation, not clobbering.
- If the final manifest or remote digest changes after verification, promotion
  must fail. Create a reviewed code fix and a higher patch version.
- Never downgrade users by running an older NSIS. Publish a higher patch version
  that restores behavior while retaining `%APPDATA%` data compatibility.
- Updater installation failures must preserve or restore the Taskboard service,
  consume `windows-update-state.json` once on the next launch and retain user
  data. Collect redacted logs before retrying.
- A published immutable Release is not edited in place. Roll forward with a new
  version; preserve the prior installer and final asset manifest for audit.

## Go criteria

Change this decision to GO only when every P0/P1 blocker above has an attached,
reviewed result; the protected workflow has one publisher; the final asset set
and hashes are immutable; macOS and Windows update tests both pass; the rollback
owner accepts data compatibility; and no task in the development plan lacks an
audit record. Deferred items require a named risk owner and written acceptance.
