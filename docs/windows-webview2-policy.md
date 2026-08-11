# Windows WebView2 distribution policy

## Supported release target

Codex Taskboard targets Windows 11 x64. The direct-download NSIS installer uses
the system Evergreen WebView2 Runtime and explicitly selects Tauri's
`downloadBootstrapper` mode with silent installation enabled.

This keeps the installer small and lets Windows/Microsoft service WebView2
security updates. The project does not pin a minimum WebView2 version until a
specific application feature proves that a minimum is required.

## Expected installer behavior

| Machine state | Expected behavior | Network requirement |
| --- | --- | --- |
| Current Evergreen runtime is installed | NSIS reuses the installed runtime | None for WebView2 |
| Runtime is absent | NSIS downloads and runs Microsoft's bootstrapper | Required during installation |
| Runtime is old but usable | The installed Evergreen runtime is used and remains serviced by its normal update mechanism | No forced download by Taskboard |
| Runtime is absent and the machine is offline | Installation cannot provision WebView2; the installer must fail visibly rather than install an unusable Taskboard | Reconnect and retry, or provision Evergreen WebView2 separately |

The release is not an offline installer. If offline enterprise deployment or
Microsoft Store distribution becomes a requirement, create a separate reviewed
configuration using `offlineInstaller`; do not silently change the direct
download package. Tauri documents an approximate 127 MB package increase for
that mode, versus no WebView2 payload in `downloadBootstrapper` mode.

## Windows validation matrix

Run these checks from clean Windows snapshots and retain installer logs:

1. Current Windows 11: install without elevation, launch Taskboard, confirm the
   WebView2 bootstrapper is not downloaded.
2. Runtime removed: install online, confirm the bootstrapper runs silently and
   Taskboard launches after installation.
3. Old Evergreen runtime: install and launch, record the runtime version before
   and after normal Evergreen servicing; confirm Taskboard either works or gives
   a clear installer/runtime failure.
4. Runtime removed and network blocked: confirm installation fails visibly,
   leaves no runnable Taskboard shortcut, and succeeds after reconnecting.

These runtime checks cannot be replaced by configuration tests on macOS.
