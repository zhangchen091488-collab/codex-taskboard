# Process lifecycle matrix

This matrix defines the process ownership and recovery evidence used by the desktop launcher. It is intentionally limited to lifecycle behavior; Windows Codex discovery, launch, CDP, and UI integration remain in WIN-050 through WIN-056.

| Scenario | Expected result | macOS automated evidence | Windows automated evidence | Runtime log/snapshot |
| --- | --- | --- | --- | --- |
| App or launcher exits intentionally | Injector, Taskboard server, Codex, and descendants exit; no restart | `MacProcessTree` cooperative/forced/orphan tests and the repeated real-tree Node matrix | `WindowsProcessTree::closing_the_owner_process_kills_job_members`; Job uses kill-on-close | Node matrix emits before/after PID snapshots; launcher logs `Launcher child ... exited` |
| Codex exits with code 0 | Injector stays resident but idles; Codex is not restarted | Real child disposition matrix | Same Node test runs on Windows CI | Matrix emits exit code, signal, and `idle` disposition |
| Codex crashes or exits by signal | Existing CDP state is closed and Codex recovery is requested | Real non-zero/signal disposition matrix plus injector source path | Same Node test runs in the Windows launcher check; full recovery is completed in WIN-056 | Matrix emits exit code, signal, and `restart` disposition |
| Node injector crashes | Remaining owned processes are terminated before the two-second launcher retry | `process_tree_stops_an_orphan_after_the_root_exits` and real orphan matrix | Job active-process tracking and kill-on-close tests; full launcher retry is completed in WIN-056 | Launcher records the child exit and recovery failure/success |
| Taskboard server crashes | Supervisor clears the old child and starts one replacement; unhealthy live child exits before replacement | Supervisor replacement/readiness tests | Same Node tests run on Windows CI | Supervisor logs unexpected exit and subsequent readiness |
| System logout, restart, or forced app teardown | Normal exit events request cleanup; OS ownership is the final fallback | Tauri `ExitRequested`/`Exit` cleanup plus `MacProcessTree::Drop` | Tauri exit cleanup plus Job kill-on-close | No destructive OS-session test in CI; final Windows VM acceptance records the event log and PID snapshot |

## Audit procedure

1. Run `test/process-lifecycle-matrix.test.mjs` and retain its JSON diagnostics.
2. Run the platform Rust tests. On Windows, these must execute rather than only compile.
3. Re-run at least two failure scenarios. The repeated launcher-stop case must show distinct PIDs and zero survivors after both attempts.
4. During final Windows VM acceptance, exercise logout/restart and retain the launcher log plus a before/after process snapshot. Remote desktop automation is not required by this repository task.
