# Windows updater asset contract

Codex Taskboard uses the Tauri v2 updater format. For Windows NSIS,
`createUpdaterArtifacts: true` signs the Authenticode-signed `setup.exe` itself
and creates `setup.exe.sig`; it does not create the legacy
`setup.nsis.zip` artifact.

The protected release build must pass two independent gates:

1. Authenticode verification proves the application and NSIS installer came
   from the approved Windows publisher and carry a timestamp.
2. Tauri minisign verification proves the exact installer bytes match the
   updater public key embedded in `tauri.conf.json`.

Passing either gate never substitutes for the other. The release build uses
`app:build:windows:release`, which requires both the Authenticode configuration
and `TAURI_SIGNING_PRIVATE_KEY` environment contract and does not serialize
either private secret into its build plan.

After Tauri creates the installer and `.sig`, run
`scripts/create-windows-updater.mjs <setup.exe> <output-directory> <release-tag>`.
It verifies the embedded public key, rejects a non-PE input or mismatched tag,
then stages a canonical setup name, `.sig`, and `windows-updater.json`. Staging
uses exclusive writes and removes files created by a failed partial operation.

`windows-updater.json` is a Windows-only intermediate fragment. WIN-064 is the
only task allowed to merge it with Darwin entries into `latest.json`.
