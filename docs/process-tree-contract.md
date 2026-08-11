# Process tree contract

This contract is deliberately limited to process trees owned by Codex Taskboard. It is not a general process-management framework.

## Lifecycle

```text
create -> Created
Created -- register one non-zero root PID --> Running
Running -- graceful stop --> Exited | Stopping (timeout)
Stopping -- force stop --> Exited | error
Running/Stopping -- liveness observes root exit --> Exited
Created/Exited -- release --> owner consumed
```

Registration is one-shot. An implementation must not adopt or kill a process merely because an old PID record contains the same number. A graceful timeout is an expected result that permits the caller to request force stop. A force-stop timeout or platform API failure is an error and must remain visible.

`release` is only valid before registration or after exit. It must not detach a live tree. This matters on Windows because closing a Job Object configured with `KILL_ON_JOB_CLOSE` terminates its members; it also prevents a macOS implementation from silently abandoning a live process group.

The Windows implementation owns both the Job Object handle and the opened root-process handle. It queries the Job's active-process count rather than treating root exit as tree exit, so descendants remain managed after the root exits. Graceful stop waits for an application-initiated exit; after the caller's deadline, force stop terminates the whole Job. Registration uses a live process handle, never PID-only rediscovery. Launchers that must eliminate the spawn-to-assignment race must create the root suspended, register it, and only then resume it; that launch primitive belongs to the Windows launcher/Codex launch tasks rather than this lifecycle contract.

Platform errors identify the failed operation, retain an optional native error code, and use a sanitized message. Liveness reports a missing root as `false`, not as a platform error. Stop calls are idempotent after exit and return `AlreadyExited`.

## Call-site mapping

| Owner | Create/register | Graceful stop | Force stop | Liveness/release |
| --- | --- | --- | --- | --- |
| Rust launcher | Create before spawning the Node injector; register immediately after a successful spawn | App quit, tray restart, normal update cleanup | Graceful timeout, startup/readiness failure, abnormal recovery cleanup | Child waiter and launcher snapshot cleanup |
| Updater flow | Reuse the launcher's owned tree; never rediscover by PID | Before installing an update | Only after the graceful deadline | Release before restart/install handoff |
| Node Taskboard supervisor | Node counterpart created when server child is spawned | `SIGTERM` with bounded wait | Platform helper after timeout | Child exit event; remove supervisor ownership |
| AI turn owner | Node counterpart created for each turn root | User cancel, timeout, parent disconnect | Graceful timeout only | Completion event removes the active turn |
| Project summary/catalog helpers | Short-lived Node counterpart | Request completion or shutdown | Bounded fallback only | Exit event removes the helper |

The Rust trait in `src-tauri/src/platform/process_tree.rs` applies directly to launcher/updater ownership. The Node counterpart in `shared/process-tree.mjs` uses the matching `already-exited` / `exited` / `timed-out` results without bridging Rust types. It validates every PID before signaling, uses negative PIDs only for an explicitly detached Unix process group, and requests graceful Windows Taskboard shutdown over versioned IPC. Windows `taskkill.exe /PID <pid> /T /F` is an absolute-path, shell-free, logged force fallback after the graceful deadline; it is not a discovery mechanism.

## Out of scope for this contract

- discovering processes with `ps`, `lsof`, WMI, or PowerShell;
- adopting an arbitrary PID from a stale record;
- Codex installation discovery or CDP transport;
- platform-specific signal, process-group, Job Object, or `taskkill` details;
- retry policy, UI recovery policy, and updater rollback.
