# Durable async runner for pi-swival

Status: Approved design

Date: 2026-08-25

Baseline: `own-background-work-drain` at `02d03fd`

## Purpose

pi-swival must keep its `swival-subagent` interface and remain independent of pi-subagents. Its asynchronous runs must survive Pi extension reloads and Pi process restarts without relying on an in-memory child-process registry.

A detached pi-swival runner will own each Swival process, its process group, lifecycle artifacts, controls, and terminal result. The Pi extension will launch runners, restore session-owned work from disk, watch durable state, replay completion notices, and reconcile stale runs.

This design covers Pi reloads and process restarts. It does not restart or continue Swival work after a machine reboot. Reconciliation marks interrupted runs failed after reboot.

## Goals

- Keep pi-swival independent of pi-subagents.
- Return from `async: true` only after a durable startup commit.
- Preserve exact child exit code and signal when the runner observes them.
- Restore active work after Pi restarts.
- Make `status`, `resume`, `interrupt`, notifications, and headless draining use persisted state.
- Prevent PID reuse from proving ownership or liveness.
- Stop and verify the complete Swival process group before normal terminal proof.
- Repair stale runs without signaling an uncertain process identity.
- Keep synchronous dispatch behavior unchanged.
- Read existing direct-spawn artifacts during migration.

## Non-goals

- Sharing lifecycle state or tools with pi-subagents.
- Adding a pi-subagents dependency, patch, event bridge, or registry fallback.
- Restarting Swival after a machine reboot.
- Resuming a Swival conversation from a checkpoint.
- Adding mid-run task steering. Swival does not expose a suitable non-interactive control channel.
- Supporting asynchronous chain or parallel modes. Asynchronous execution remains single-agent only.
- Promising exactly-once notification delivery.

## Architecture

New asynchronous runs use four components:

1. The extension validates the request, creates a private run directory, writes the launch contract, and completes the startup handshake.
2. A detached Node runner validates the launch contract, waits for authorization, starts Swival, owns its process group, consumes controls, and writes lifecycle artifacts.
3. The session tracker restores owned runs from disk, watches their state, and supplies status to tools and headless draining.
4. The reconciler repairs runs whose runner died before terminal commitment.

The runner executes TypeScript through the Jiti runtime already installed with Pi. pi-swival does not add a pi-subagents runtime or test dependency.

Proposed source boundaries:

```text
extensions/
├── runtime.ts
├── notify.ts
├── observability.ts
└── async/
    ├── protocol.ts
    ├── artifacts.ts
    ├── launcher.ts
    ├── runner.ts
    ├── control.ts
    ├── reconcile.ts
    └── tracker.ts
```

`runtime.ts` keeps tool registration, parameter validation, agent discovery, and dispatch routing. The `async/` modules own the durable protocol.

## Run directory

Each run uses a directory under `~/.pi/agent/swival-artifacts/`, unless `PI_SWIVAL_ARTIFACT_ROOT` selects another validated root.

```text
<run-id>/
├── launch.json
├── startup.json
├── status.json
├── events.jsonl
├── stdout.txt
├── stderr.txt
├── report.json
├── result.json
├── trace/
└── control/
    ├── startup-ack.json
    ├── startup-proceed.json
    ├── requests/
    ├── acknowledgements/
    └── notifications/
```

`launch.json` is immutable. `startup.json` records the handshake. `status.json` is the current projection. `result.json` is the immutable normal terminal record. `events.jsonl` is diagnostic and can be incomplete. The runner derives every lifecycle path from the validated run directory.

## Lifecycle state machine

`status.json` uses these states:

| State | Meaning |
| --- | --- |
| `launching` | The run directory exists, but startup is not committed. |
| `running` | The runner accepted ownership and may start or own Swival. |
| `interrupting` | The runner accepted an interrupt request and is stopping Swival. |
| `accepted` | Swival succeeded after one or more review rounds. |
| `completed` | Swival succeeded without review acceptance. |
| `rejected` | The reviewer rejected the result. |
| `error` | Swival reported an internal outcome error. |
| `failed` | Startup, execution, artifact validation, or reconciliation failed. |
| `stopped` | An accepted interrupt stopped the run. |

Allowed state transitions are:

```text
absent -> launching
launching -> running | failed
running -> interrupting | accepted | completed | rejected | error | failed
interrupting -> stopped | accepted | completed | rejected | error | failed
```

A natural completion can win a race with an interrupt. Once a terminal decision exists, later controls cannot change it.

The live runner is the only writer of `status.json`. It serializes heartbeats, controls, and lifecycle transitions through one internal queue. The extension writes control files, not status. The reconciler can write status only after it verifies that the runner identity is dead.

A valid `result.json` is the terminal decision for normal completion. The runner publishes it with atomic no-replace semantics. Reconciliation never overwrites it. `status.json` is a projection and can be repaired to match the immutable result.

If result persistence fails, the runner may write a terminal `failed` status with bounded `result-unavailable` diagnostics. This exception prevents a storage failure from leaving a permanently active run. Reconciliation uses the same exception.

## Startup ownership handshake

The extension completes this sequence for a new asynchronous run:

1. Create the run directory with mode `0700`.
2. Write `launch.json` and `status.json` atomically with mode `0600`.
3. Calculate a SHA-256 digest of the canonical launch contract.
4. Start a detached Node runner with the launch path and expected digest.
5. Wait for `startup.json` with state `ready`.
6. Validate the run ID, launch digest, runner identity, and random 256-bit startup token.
7. Write `control/startup-ack.json` with the token.
8. Wait for `startup.json` with state `acknowledged` and the same token.
9. Write `control/startup-proceed.json` atomically.
10. Return the run ID and artifact directory.

`startup-proceed.json` is the commit point. The runner never starts Swival before it validates this record.

Before the commit point, cancellation or startup failure makes the extension terminate the runner and return a startup error. After the commit point, the extension never rolls back the run. If it cannot observe later progress, it returns the run ID with an indeterminate-start warning. Reconciliation then determines the outcome.

Startup failures include:

- Run-directory creation or atomic-write failure.
- Invalid launch schema, digest, ownership, permissions, or paths.
- Missing or unsuitable Node or Jiti runtime.
- Runner spawn failure or missing PID.
- Ready, acknowledgement, or proceed timeout.
- Token, run ID, session ID, digest, or runner-instance mismatch.
- Runner death before the commit point.
- Working directory disappearance.

`launch.json` contains the task and resolved non-secret options. It never contains credentials, authentication headers, or environment values. The runner inherits its environment when the extension starts it.

## Process ownership and identity

The process layout is:

```text
Pi process
└── detached pi-swival runner process group
    └── detached Swival process group
        └── Swival descendants
```

The separate Swival group lets the runner stop Swival without killing itself. The runner remains alive to finish artifact writes.

Runner identity includes:

- PID and OS process start time.
- Random runner instance ID.
- Run ID and launch digest.
- Startup timestamp and heartbeat.

Child identity includes:

- PID and process-group ID.
- OS process start time.
- Random child instance ID.
- Spawn timestamp.
- Secret-free command digest.
- Owning runner instance ID.

A PID probe supports liveness checks only. A PID never proves identity, ownership, terminal success, or exit status. Every signal operation requires a matching identity and process start time. An uncertain identity is never signaled.

## Terminal proof and process-group cleanup

The runner holds the Swival `ChildProcess` object and observes its `close` event. That event supplies the direct child's exact exit code and signal, but it does not prove that descendants exited.

Before normal terminal commitment, the runner must:

1. Observe the direct child close.
2. Enumerate the Swival process group.
3. Wait for a short natural-exit grace period.
4. Send `SIGTERM` if descendants remain.
5. Send `SIGKILL` after the configured escalation interval if necessary.
6. Verify that the process group is empty.

Normal proof is `observed` only after complete group verification. If cleanup or verification fails, the logical run becomes `failed`, `processFate` becomes `unknown`, and `cleanupPending` remains true. Reconciliation continues cleanup attempts after logical completion. Headless draining treats `cleanupPending` as active work until its drain timeout.

Terminal proof has three forms:

| Proof | Meaning |
| --- | --- |
| `observed` | The runner observed direct child close and verified that the process group ended. |
| `reconciled` | Reconciliation proved runner loss, handled any verified child group, and committed a synthetic terminal record. |
| `unknown-child-fate` | Reconciliation could not verify the child identity or process-group fate. |

Normal terminal write order is:

1. Verify process-group termination.
2. Finish stdout and stderr handling.
3. Read and validate `report.json`.
4. Publish `result.json` atomically without replacement.
5. Write terminal `status.json` atomically.
6. Append a terminal event best-effort.
7. Exit the runner.

If `result.json` cannot be written, the runner writes terminal `failed` status with bounded diagnostics and artifact references. `resume` reports the failure and available artifact paths.

## Outcome mapping

The durable runner preserves current public outcome semantics:

| Evidence | Status |
| --- | --- |
| Exit `0`, report outcome `success`, review rounds greater than zero | `accepted` |
| Exit `0`, report outcome `success`, no review rounds | `completed` |
| Exit `0`, report outcome `failed` | `rejected` |
| Exit `0`, report outcome `error` | `error` |
| Unexplained nonzero exit | `failed` |
| Accepted interrupt followed by verified termination | `stopped` |
| Exit `0` with missing, malformed, or unknown report | `completed` with a report-health warning and stdout fallback |
| Runner loss without a terminal result | `failed` with a reconciliation reason |

## Durable interrupt protocol

The extension sends interrupts through files under `control/`.

Each request contains:

- Protocol version.
- Request ID and `interrupt` action.
- Run ID and canonical owner session ID.
- Expected runner instance ID.
- Request timestamp.

The protocol is:

1. The extension validates ownership and current state.
2. It writes `control/requests/<request-id>.json` atomically without replacement.
3. The runner discovers it through `fs.watch` or fallback polling.
4. The runner validates the file, schema, run, session, and runner instance.
5. Its serialized state queue changes `running` to `interrupting`.
6. It writes `control/acknowledgements/<request-id>.json`.
7. It sends `SIGTERM` to the verified Swival process group.
8. It sends `SIGKILL` after five seconds if processes remain.
9. It verifies that the group is empty.
10. It commits `stopped`, unless a natural terminal result already won.

Duplicate requests are idempotent and do not restart escalation timers. A request against a terminal run receives an `already-terminal` acknowledgement.

The tool waits briefly for acknowledgement. If no acknowledgement arrives, it reports that the interrupt is durably queued. It does not claim that a signal was sent.

A valid pending request remains durable interruption intent after runner loss. Reconciliation applies it only to a verified child group.

## Stale-run reconciliation

Reconciliation runs during:

- `session_start`.
- `status`, `resume`, and `interrupt` actions.
- Headless `agent_end` draining.
- Filesystem watcher callbacks.
- A five-second safety sweep.

Each scan selects runs whose canonical owner session ID matches the current session.

| Durable evidence | Reconciliation action |
| --- | --- |
| Valid result with nonterminal or inconsistent status | Repair status from the result. |
| Terminal failed status with `result-unavailable` | Preserve it and expose its diagnostics. |
| Verified live runner with a fresh heartbeat | Leave active. |
| Verified live runner with a stale heartbeat | Report derived health as unresponsive without writing status or terminalizing the run. |
| Dead runner with a verified live child group | Terminate and verify the group, then synthesize failure or stop. |
| Dead runner with no child group | Synthesize `failed/runner-lost`. |
| Dead runner with uncertain child identity | Synthesize failure with unknown process fate and continue cleanup reconciliation. |
| Dead runner before startup proceed | Commit `failed/startup-abandoned`. |
| Dead runner after startup proceed | Reconcile as committed work. |
| Corrupt or untrusted identity data | Quarantine the run and signal nothing. |

A valid pending interrupt produces `stopped` after verified cleanup. A committed natural result remains authoritative.

Reconciliation is idempotent. Concurrent reconcilers use atomic no-replace publication. A loser reads the winner's result and repairs its status projection. Diagnostic event writes do not control reconciliation.

After a machine reboot, dead process identities produce runner-loss failure. The system never restarts Swival.

## Session tracking and headless draining

The canonical owner is `sessionManager.getSessionId()`. Session file paths are metadata, not ownership identifiers.

During `session_start`, the tracker scans durable state, restores active session-owned runs, attaches watchers, and starts the safety sweep. `session_shutdown` removes watchers and timers but never stops a committed runner.

`/new`, `/fork`, and `/resume` replace session-bound tracker state. The new session restores only its own runs.

Headless `agent_end` repeatedly scans persisted state for the current session. It waits while any run is `launching`, `running`, `interrupting`, or has `cleanupPending: true`. Filesystem notifications wake the drain promptly, and bounded polling covers missed events. The existing 30-minute ceiling remains. A timeout stops waiting but never signals a run.

An unpersisted Pi session can start asynchronous work, but the tool warns that no Pi session can restore it after process exit. Headless draining still applies during the current process.

## Status and resume behavior

`status` reads validated durable state. It reports lifecycle state, proof strength, process-fate warnings, elapsed time, current turn, last tool, last activity, review round, and known cost.

`resume` requires a terminal logical state. It reads bounded output from `result.json`, `report.json`, or `stdout.txt` in that order. It includes reviewer feedback when available. Missing or corrupt artifacts produce explicit diagnostics instead of an inferred success.

`status`, `resume`, and `interrupt` require an exact owner session ID match. A different Pi session cannot control the run by guessing its ID.

## Notification replay and deduplication

Terminal `status.json` and `result.json` drive notifications. `events.jsonl` is never the notification authority.

Each terminal decision has a deterministic notice key derived from the session ID, run ID, and either the result digest or the terminal `result-unavailable` status digest.

On session restoration, the notifier:

1. Scans current Pi session history for persisted `swival-notify` messages.
2. Marks matching notice keys acknowledged when history already contains them.
3. Finds terminal owned runs without acknowledgement.
4. Claims delivery with a short durable lease.
5. Sends a notice with its batch ID and exact notice-key set.
6. Waits for the matching persisted `message_end`.
7. Writes an atomic per-run acknowledgement under `control/notifications/`.

Acknowledgement requires the current session ID, expected custom message type, exact batch ID, and exact notice-key set.

Clean completions can batch for 1.5 seconds. Failures, rejections, errors, and stops deliver immediately. Notices contain status, agent, run ID, and artifact path. They do not contain task output.

Delivery is at-least-once. Session-history inspection reduces duplicates after crashes, but a crash between persistence and acknowledgement can still cause replay.

## Security validation

The artifact root and run directories use mode `0700`. Files use mode `0600`. Run IDs contain at least 128 random bits.

Every artifact read validates:

- Protocol version and strict schema.
- File type and size. Launch files are limited to 4 MiB; startup, status, and control files to 256 KiB; result and report files to 16 MiB; and event lines to 1 MiB.
- Owner UID and permissions where the platform exposes them.
- Run ID, session ID, and runner instance.
- Canonical path containment.
- Expected regular-file status.

Readers reject symlinks and unexpected file types. File operations use no-follow behavior where supported. The runner rejects a root or run directory that is symlinked, owned by another user, or writable by group or other users.

The runner derives lifecycle paths from its validated directory. Launch and control records cannot redirect status, result, stdout, stderr, or notification files.

Corrupt identity data is never used to signal a process. An identity check that returns unknown blocks signaling and produces explicit uncertainty.

The runner never logs or persists its inherited environment. Artifact diagnostics redact command arguments that could contain sensitive task content. The task remains private because `launch.json` is mode `0600`.

## Retention and cleanup

Terminal runs with resolved process cleanup become eligible for deletion seven days after `endedAt`. Active runs are never age-pruned. A stale active run must reconcile before deletion.

Runs with `cleanupPending: true` are not pruned automatically. Reconciliation keeps trying to establish process-group absence. Manual deletion remains possible for an operator who accepts the unresolved process-fate warning.

Unacknowledged notices remain replayable until artifact retention removes the run. Atomic-write temporary files are removed after successful publication or during pruning. Startup and control records remain with the run until pruning.

The pruner validates every directory before deletion. It skips symlinks, corrupt entries, non-directories, and paths outside the artifact root.

## Migration from direct spawning

New asynchronous launches use durable protocol version 1 and the detached runner. Synchronous dispatch remains unchanged.

A legacy adapter reads existing `run-meta.json`, `completed.json`, `spawn-error.txt`, `report.json`, stdout, and stderr files.

- Completed legacy runs keep current `status`, `resume`, and notification behavior.
- A live legacy run held by the current extension process keeps its existing listener.
- After extension restart, a legacy run has no durable owner.
- The adapter can identity-check and interrupt a live legacy process group. This is the only extension-side signaling exception.
- If a legacy process disappears without `completed.json`, reconciliation records `failed/legacy-owner-lost`.
- A legacy report can supply output but cannot prove a missing exit status.
- Migration never rewrites legacy artifacts destructively.

Migration proceeds in this order:

1. Add protocol schemas and artifact primitives.
2. Add the detached runner and startup handshake.
3. Add durable controls and stale reconciliation.
4. Restore jobs during session startup.
5. Move notifications and headless draining to persisted state.
6. Add the legacy adapter.
7. Remove new-run dependence on `asyncRuns` and direct child listeners.
8. Update README and skill documentation.

## Test strategy

### Focused tests

The focused suite covers:

- Every allowed and forbidden lifecycle transition.
- Serialized runner status writes.
- Atomic write and no-replace publication.
- Schema, size, permission, symlink, and containment checks.
- Every startup handshake failure boundary.
- Token, digest, session, run, and runner-identity mismatches.
- PID reuse and process-start-time mismatch.
- Child exit and report-to-status mapping.
- Complete process-group verification.
- Result-write failure fallback.
- Duplicate and racing interrupt requests.
- Signal escalation.
- Every stale-reconciliation rule.
- Notification batching, acknowledgement, replay, and crash windows.
- Session isolation.
- Retention and unresolved cleanup.
- Every supported legacy artifact state.

### Multi-process integration tests

Integration tests use a fake `swival` executable. It can succeed, fail, hang, emit reports, and spawn descendants. Tests make no provider requests and use no credentials.

Required scenarios are:

1. Normal durable success.
2. Every public terminal outcome.
3. Extension shutdown and recreation while the runner continues.
4. Status, resume, and notification after recreation.
5. Interrupt after extension recreation.
6. Runner death while a child remains alive.
7. Direct-child exit while a descendant remains.
8. Process-group escalation and verified cleanup.
9. Runner death before result publication.
10. Result publication before status publication.
11. Notification delivery before acknowledgement.
12. Headless `agent_end` draining from persisted state.
13. Simulated machine reboot without automatic restart.
14. Two reconcilers competing for one stale run.
15. Legacy restoration and owner loss.

Fault injection stops the launcher or runner at each handshake and terminal-write boundary. Multi-process tests start separate harness processes so module reset cannot stand in for a Pi process restart.

Process-group tests are required on supported POSIX systems. Other platforms must report unsupported proof instead of claiming verified cleanup.

## Quality gates

The change must pass:

- The existing 224 tests.
- All new focused and integration tests.
- `npm run smoke`.
- `npm run ci`.
- `shellcheck` for modified shell scripts.
- `markdownlint` for modified Markdown.
- A package-load test through Pi's installed extension runtime.

Tests use temporary directories and local processes only.

## Acceptance criteria

The implementation is complete when:

- A run survives extension reload and Pi process restart.
- The same Pi session can restore, inspect, interrupt, and resume the run.
- Another Pi session cannot control it.
- Headless draining discovers work from disk without `asyncRuns`.
- The runner starts no Swival child before startup proceed.
- The runner records exact direct-child exit data when it observes close.
- Normal terminal proof requires verified process-group cleanup.
- Stale reconciliation never signals an uncertain identity.
- Result-write failure cannot leave an active run indefinitely.
- Terminal status and result drive notification replay.
- Notification acknowledgement survives restart.
- Existing direct-spawn artifacts remain readable.
- New asynchronous execution has no pi-subagents runtime or test dependency.
- Documentation describes the durable behavior and its machine-reboot limit.
