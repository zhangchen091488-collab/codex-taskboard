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

Platform errors identify the failed operation, retain an optional native error code, and use a sanitized message. Liveness reports a missing root as `false`, not as a platform error. Stop calls are idempotent after exit and return `AlreadyExited`.

## Call-site mapping

| Owner | Create/register | Graceful stop | Force stop | Liveness/release |
| --- | --- | --- | --- | --- |
| Rust launcher | Create before spawning the Node injector; register immediately after a successful spawn | App quit, tray restart, normal update cleanup | Graceful timeout, startup/readiness failure, abnormal recovery cleanup | Child waiter and launcher snapshot cleanup |
| Updater flow | Reuse the launcher's owned tree; never rediscover by PID | Before installing an update | Only after the graceful deadline | Release before restart/install handoff |
| Node Taskboard supervisor | Node counterpart created when server child is spawned | `SIGTERM` with bounded wait | Platform helper after timeout | Child exit event; remove supervisor ownership |
| AI turn owner | Node counterpart created for each turn root | User cancel, timeout, parent disconnect | Graceful timeout only | Completion event removes the active turn |
| Project summary/catalog helpers | Short-lived Node counterpart | Request completion or shutdown | Bounded fallback only | Exit event removes the helper |

The Rust trait in `src-tauri/src/platform/process_tree.rs` applies directly to launcher/updater ownership. WIN-044 will provide the Node counterpart with the same `AlreadyExited` / `Exited` / `TimedOut` semantics; Node code does not implement or bridge to the Rust trait.

## Out of scope for this contract

- discovering processes with `ps`, `lsof`, WMI, or PowerShell;
- adopting an arbitrary PID from a stale record;
- Codex installation discovery or CDP transport;
- platform-specific signal, process-group, Job Object, or `taskkill` details;
- retry policy, UI recovery policy, and updater rollback.
