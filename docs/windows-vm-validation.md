# Windows 11 installer and updater validation

This runbook is the deferred runtime gate for WIN-060 through WIN-066. Run it
locally on a disposable Windows 11 x64 VM after the implementation phase. The
repository does not use remote-desktop automation for this gate.

The evidence collector is read-only. It does not install, stop, uninstall or
delete anything. Every install/uninstall action below is an explicit verifier
action. Evidence JSON contains registry paths and certificate subjects; inspect
it before sharing outside the release team.

## Inputs and clean snapshot

Prepare two Authenticode-signed NSIS installers from the same publisher:

- `N`, the installed baseline (for example `0.2.2`);
- `N+1`, a strictly newer `major.minor.patch` release.

Both installers must already have passed
`scripts/verify-windows-authenticode.ps1`. Start from a clean Windows 11 x64
snapshot with no Codex Taskboard install entry or application data. In a normal
PowerShell terminal, define values for the VM:

```powershell
$Repo = "C:\src\dashi-taskboard"
$Evidence = "C:\release-evidence\codex-taskboard-vm"
$InstallerN = "C:\installers\Codex Taskboard_0.2.2_x64-setup.exe"
$InstallerN1 = "C:\installers\Codex Taskboard_0.2.3_x64-setup.exe"
$VersionN = "0.2.2"
$VersionN1 = "0.2.3"
$Publisher = "<exact Authenticode certificate subject>"
$Capture = Join-Path $Repo "scripts\capture-windows-vm-evidence.ps1"
```

Capture the clean state before installing anything:

```powershell
& $Capture -Scenario clean -EvidenceDirectory $Evidence
```

Each scenario file is create-only. If a step must be repeated, restore the VM
snapshot and use a new empty evidence directory; do not overwrite a failed run.

## Seven-stage matrix

For every stable-state capture, exit Codex Taskboard from its tray menu and
confirm its managed Taskboard Node/Codex process tree has ended. The verifier
rejects residual managed processes and a stale `windows-update-state.json`.

1. Install `N` for the current user. Tauri NSIS supports silent install with an
   uppercase `/S`, or the installer can be run interactively:

   ```powershell
   Start-Process -FilePath $InstallerN -ArgumentList "/S" -Wait
   ```

   Launch the app once, confirm the Taskboard becomes ready, then exit it. Create
   one non-secret data-retention sentinel after the first successful launch:

   ```powershell
   $Data = Join-Path $env:APPDATA "com.chuspeeism.codex-taskboard"
   New-Item -ItemType Directory -Force -Path $Data | Out-Null
   Set-Content -LiteralPath (Join-Path $Data ".windows-vm-matrix-sentinel.txt") `
     -Value "retain-across-upgrade-and-uninstall" -NoNewline
   & $Capture -Scenario installed-n -EvidenceDirectory $Evidence `
     -ExpectedVersion $VersionN -ArtifactVersion $VersionN `
     -ArtifactPath $InstallerN -ExpectedSubject $Publisher
   ```

2. Start `N`, use its built-in updater to install `N+1`, and accept the update.
   Confirm the restarted app reports `N+1` and Taskboard readiness, then exit:

   ```powershell
   & $Capture -Scenario upgraded-n-plus-one -EvidenceDirectory $Evidence `
     -ExpectedVersion $VersionN1 -ArtifactVersion $VersionN1 `
     -ArtifactPath $InstallerN1 -ExpectedSubject $Publisher
   ```

3. Run the same `N+1` installer again. Confirm the app remains at `N+1`, launches,
   and exits cleanly:

   ```powershell
   Start-Process -FilePath $InstallerN1 -ArgumentList "/S" -Wait
   & $Capture -Scenario same-version-reinstall -EvidenceDirectory $Evidence `
     -ExpectedVersion $VersionN1 -ArtifactVersion $VersionN1 `
     -ArtifactPath $InstallerN1 -ExpectedSubject $Publisher
   ```

4. Run the older `N` installer interactively. The reviewed Windows config sets
   `allowDowngrades: false`; the installer must refuse and leave `N+1` installed:

   ```powershell
   Start-Process -FilePath $InstallerN -Wait
   & $Capture -Scenario downgrade-attempt -EvidenceDirectory $Evidence `
     -ExpectedVersion $VersionN1 -ArtifactVersion $VersionN `
     -ArtifactPath $InstallerN -ExpectedSubject $Publisher
   ```

5. Uninstall Codex Taskboard from Windows Settings. Confirm the install entry,
   shortcuts, launcher and managed process tree are gone. The application data
   and sentinel must remain:

   ```powershell
   & $Capture -Scenario uninstalled -EvidenceDirectory $Evidence
   ```

6. Reinstall `N+1`, launch once, confirm readiness, then exit:

   ```powershell
   Start-Process -FilePath $InstallerN1 -ArgumentList "/S" -Wait
   & $Capture -Scenario reinstalled-n-plus-one -EvidenceDirectory $Evidence `
     -ExpectedVersion $VersionN1 -ArtifactVersion $VersionN1 `
     -ArtifactPath $InstallerN1 -ExpectedSubject $Publisher
   ```

The clean capture is stage zero, so these actions produce the required seven
scenario files.

## Verify and preserve evidence

Run the cross-platform verifier from the repository:

```powershell
node scripts\verify-windows-vm-matrix.mjs $Evidence
```

It verifies Windows 11 x64, one current-user install, version progression,
same-version reinstall, downgrade refusal, exact signer continuity, timestamped
installers, data retention, one-time update-state cleanup and zero residual
managed processes. Preserve its console output with the seven JSON files.

Also retain screenshots for the successful `N+1` restart, downgrade refusal and
Windows uninstall result, plus the local launcher log. Do not upload application
data, certificate files, signing passwords, updater private keys or process
command lines.

If any stage fails, stop the matrix, record the stage and observed result, and
restore the clean snapshot before retrying after a code fix. A partial or
manually edited evidence directory is not an acceptance result.
