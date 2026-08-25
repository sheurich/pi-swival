# Durable async runner implementation plan

> For agentic workers: REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task by task. Track each checkbox in order. Do not start a later task before its dependency and commit pass.

Goal: Replace direct async Swival spawning with a detached, durable Node runner while leaving synchronous execution unchanged.

Architecture: The extension will create and authorize versioned run artifacts. A detached runner will own one Swival process group, serialize status writes, consume durable controls, prove process-group cleanup, and publish one immutable terminal result. The extension will restore session-owned runs, reconcile dead runners, replay acknowledged notifications, and adapt legacy artifacts without using pi-subagents at runtime or in tests.

Tech stack: TypeScript, Node child processes and filesystem APIs, Jiti from the installed Pi runtime, Vitest, POSIX `ps` and process groups, Pi extension lifecycle hooks.

---

## Scope and constraints

This plan implements `docs/superpowers/specs/2026-08-25-durable-swival-runner-design.md` as one dependency-ordered project. The subsystems are not independent deliverables. The runner, reconciler, tracker, notifier, and control tools all consume the same protocol and artifact validation layer.

Keep these constraints active for every task:

- Do not import or depend on pi-subagents source, package exports, runtime state, tools, events, tests, or artifact directories.
- Use the pi-subagents files named in the specification as read-only design references only.
- Keep `runSingleSwival()` and every synchronous single, chain, and parallel code path behaviorally unchanged.
- Keep asynchronous execution single-agent only.
- Use `sessionManager.getSessionId()` as the only ownership identifier. Treat session file paths as metadata.
- Never signal a durable runner or Swival process from a persisted PID alone.
- Treat `events.jsonl` as diagnostic output only.
- Do not claim normal terminal success until the complete Swival process group is empty.
- Do not add provider calls, credentials, network access, machine-reboot continuation, steering, or async chain and parallel support.
- Run all tests with temporary directories and local fake processes.

## File map

Create these production modules:

- `extensions/async/protocol.ts`: versioned schemas, lifecycle transitions, terminal-state predicates, canonical launch digest, outcome mapping, bounded diagnostics, and notice-key derivation.
- `extensions/async/artifacts.ts`: `launch.json`, `startup.json`, `status.json`, stream, report, result, trace, event, and control path derivation; root and run-directory validation; secure bounded reads; atomic replacement; atomic no-replace publication; JSONL append; scanning; and pruning.
- `extensions/async/process.ts`: process identity capture and verification, process-group enumeration, verified signaling, escalation, and cleanup proof.
- `extensions/async/launcher.ts`: Node and Jiti resolution, launch creation, detached runner spawn, startup handshake, pre-commit rollback, and post-commit warning behavior.
- `extensions/async/runner.ts`: executable runner entry point, launch validation, handshake responder, serialized lifecycle queue, heartbeat, Swival spawn, output ownership, controls, timeout, report validation, terminal publication, and runner exit.
- `extensions/async/control.ts`: durable interrupt request and acknowledgement records, request discovery, idempotence, and acknowledgement waiting.
- `extensions/async/reconcile.ts`: stale-run decision table, dead-runner proof, result/status repair, synthetic terminal publication, unresolved cleanup, and quarantine.
- `extensions/async/tracker.ts`: session-owned restoration, watchers, five-second safety sweeps, durable control-state loading, drain snapshots, and tracker disposal.
- `extensions/async/legacy.ts`: non-destructive reads and control behavior for `run-meta.json`, `completed.json`, `spawn-error.txt`, legacy reports, and current-process legacy listeners.

Modify these production and documentation files:

- `extensions/runtime.ts`: retain shared dispatch validation and synchronous execution; route new async launches and control actions through the durable modules; bind session lifecycle, tracking, draining, and notification dependencies.
- `extensions/notify.ts`: replace legacy completion-marker scanning with terminal status/result notice keys, durable leases, session-history deduplication, and per-run acknowledgement files.
- `extensions/observability.ts`: keep stderr and trace parsers; expose durable status observability helpers without using wall-clock launch time as process identity.
- `tests/agentEndDrain.test.ts`: make draining consume durable tracker snapshots and `cleanupPending` state.
- `tests/asyncNotify.test.ts`: replace `completed.json` and `notified.json` assumptions with notice keys, leases, history recovery, and acknowledgement files.
- `tests/extensionWiring.test.ts`: test canonical session ownership, session replacement, durable launch/control routing, restoration, notification replay, and persisted draining.
- `scripts/smoke-test.sh`: add explicit runner/Jiti package-load coverage without executing Swival.
- `README.md`: document durable async behavior, artifact protocol, restoration, interruption, reboot limits, notification delivery, migration, and independence.
- `skills/swival/SKILL.md`: update operational guidance for durable startup, status, resume, interrupt, restoration, and notification semantics.

Create these test files and helpers:

- `tests/asyncProtocol.test.ts`
- `tests/asyncArtifacts.test.ts`
- `tests/asyncProcess.test.ts`
- `tests/asyncLauncher.test.ts`
- `tests/asyncRunner.test.ts`
- `tests/asyncControl.test.ts`
- `tests/asyncReconcile.test.ts`
- `tests/asyncTracker.test.ts`
- `tests/asyncLegacy.test.ts`
- `tests/asyncIntegration.test.ts`
- `tests/helpers/fake-swival.mjs`
- `tests/helpers/async-host.ts`
- `tests/helpers/async-test-kit.ts`

## Protocol contracts to keep consistent

Define these names in Task 1 and reuse them without aliases in later tasks:

```ts
export const ASYNC_PROTOCOL_VERSION = 1;

export type RunLifecycleState =
  | "launching"
  | "running"
  | "interrupting"
  | "accepted"
  | "completed"
  | "rejected"
  | "error"
  | "failed"
  | "stopped";

export type TerminalProof =
  | "observed"
  | "reconciled"
  | "unknown-child-fate";

export type ProcessFate = "running" | "ended" | "unknown";

export interface ProcessIdentity {
  pid: number;
  startTimeMs: number;
  instanceId: string;
}

export interface ChildIdentity extends ProcessIdentity {
  processGroupId: number;
  spawnedAt: number;
  commandDigest: string;
  runnerInstanceId: string;
}

export interface LaunchRecordV1 {
  version: 1;
  runId: string;
  ownerSessionId: string;
  ownerSessionPersisted: boolean;
  agent: string;
  task: string;
  cwd: string;
  command: "swival";
  args: string[];
  createdAt: number;
  runnerInstanceId: string;
  commandDigest: string;
}

export interface ResultRecordV1 {
  version: 1;
  runId: string;
  ownerSessionId: string;
  agent: string;
  state: Extract<RunLifecycleState,
    "accepted" | "completed" | "rejected" | "error" |
    "failed" | "stopped">;
  endedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminalProof: TerminalProof;
  processFate: ProcessFate;
  cleanupPending: boolean;
  finalOutput?: string;
  reviewerFeedback?: string;
  reportHealth: "valid" | "missing" | "malformed" | "unknown-outcome";
  reason?: string;
  diagnostics?: string[];
}
```

Define `StatusRecordV1` as a discriminated union. `LaunchingStatusRecordV1` has `state: "launching"`, the immutable run and owner fields, and the pre-generated `runnerInstanceId`, but it cannot contain a runner PID or OS start time. `RunnerOwnedStatusRecordV1` covers every later state and requires a complete runner `ProcessIdentity` whose instance ID equals `runnerInstanceId`. Both variants include lifecycle timestamps, exit data when known, process fate, cleanup state, report health, and bounded diagnostics. The runner-owned variant also includes heartbeat, optional child identity, recent verified group-member identities, and observability fields for turn, tool, activity, review round, and cost. The launcher can write only the initial launching variant. After the runner publishes `ready`, only the runner can write live status.

`StartupRecordV1`, `InterruptRequestV1`, `InterruptAckV1`, `NotificationLeaseV1`, and `NotificationAckV1` must repeat protocol version, run ID, owner session ID, and the expected runner or notice identity needed to reject cross-run replay.

Use these constants unless a test injects shorter values:

```ts
export const RUNNER_STARTUP_TIMEOUT_MS = 10_000;
export const RUNNER_HEARTBEAT_INTERVAL_MS = 1_000;
export const RUNNER_STALE_AFTER_MS = 15_000;
export const TRACKER_SWEEP_INTERVAL_MS = 5_000;
export const CONTROL_POLL_INTERVAL_MS = 250;
export const NATURAL_GROUP_EXIT_GRACE_MS = 1_000;
export const PROCESS_TERM_GRACE_MS = 5_000;
export const PROCESS_KILL_VERIFY_MS = 1_000;
export const CLEAN_NOTICE_BATCH_WINDOW_MS = 1_500;
export const NOTIFICATION_LEASE_MS = 30_000;
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
```

## Dependency order

```text
Task 1 protocol
  -> Task 2 artifacts
      -> Task 3 process proof
          -> Task 4 launcher handshake
              -> Task 5 runner lifecycle
                  -> Task 6 controls
                      -> Task 7 reconciliation
                          -> Task 8 tracking and tool reads
                              -> Task 8A legacy adapter extraction
                                  -> Task 9 notifications
                                      -> Task 10 wiring and draining
                                          -> Task 11 retention
                                              -> Task 12 integration matrix
                                                  -> Task 13 documentation
                                                      -> Task 14 final gates
```

## Task 1: Freeze the versioned protocol and lifecycle rules

Dependencies: None.

Files:

- Create: `extensions/async/protocol.ts`
- Create: `tests/asyncProtocol.test.ts`

- [ ] Step 1: Write failing protocol tests.

Cover these exact cases:

```ts
it("accepts every approved lifecycle transition");
it("rejects every transition absent from the approved state graph");
it("recognizes only the six terminal lifecycle states");
it("accepts launching status with runnerInstanceId and no PID or start time");
it("rejects launching status that claims a complete runner identity");
it("requires complete matching runner identity for every later status");
it("maps exit zero and a successful reviewed report to accepted");
it("maps exit zero and a successful unreviewed report to completed");
it("maps failed and error report outcomes without using the exit code");
it("maps unexplained nonzero exits to failed");
it("maps an accepted interrupt plus verified cleanup to stopped");
it("maps exit zero with a missing or invalid report to completed with warning");
it("canonicalizes object keys before hashing a launch record");
it("changes the launch digest when a covered field changes");
it("derives the same deterministic notice key from equivalent records");
it("bounds diagnostics by line count and UTF-8 byte count");
it("rejects unknown versions and excess properties in every record parser");
```

Build table-driven transition tests from the specification's state graph. Assert that `events.jsonl` does not appear in any terminal-decision or notice-key function signature.

- [ ] Step 2: Run the focused test and confirm the missing-module failure.

Run:

```bash
cd tests
npx vitest run asyncProtocol.test.ts
```

Expected: FAIL because `extensions/async/protocol.ts` does not exist.

- [ ] Step 3: Implement strict parsers and pure protocol functions.

Export these functions:

```ts
export function parseLaunchRecord(value: unknown): LaunchRecordV1;
export function parseStartupRecord(value: unknown): StartupRecordV1;
export function parseStatusRecord(value: unknown): StatusRecordV1;
export function parseResultRecord(value: unknown): ResultRecordV1;
export function parseInterruptRequest(value: unknown): InterruptRequestV1;
export function parseInterruptAck(value: unknown): InterruptAckV1;
export function parseNotificationLease(value: unknown): NotificationLeaseV1;
export function parseNotificationAck(value: unknown): NotificationAckV1;
export function assertLifecycleTransition(
  from: RunLifecycleState | "absent",
  to: RunLifecycleState,
): void;
export function isTerminalState(state: RunLifecycleState): boolean;
export function mapTerminalOutcome(input: TerminalOutcomeInput): TerminalOutcome;
export function canonicalJson(value: unknown): string;
export function launchDigest(record: LaunchRecordV1): string;
export function commandDigest(command: string, args: readonly string[]): string;
export function noticeKey(input: NoticeKeyInput): string;
export function boundDiagnostics(lines: readonly string[]): string[];
```

Reject missing fields, excess fields, non-finite timestamps, invalid PIDs, weak IDs, unknown states, mismatched nested IDs, and over-limit strings. Require run IDs and instance IDs to contain at least 128 random bits in the generated form. Keep parser logic dependency-free so the detached runner can load it through Jiti.

- [ ] Step 4: Run the focused test and the existing outcome tests.

Run:

```bash
cd tests
npx vitest run asyncProtocol.test.ts summarizeReport.test.ts
```

Expected: PASS.

- [ ] Step 5: Commit the protocol stage.

```bash
git add extensions/async/protocol.ts tests/asyncProtocol.test.ts
git commit -m "Define durable async protocol"
```

## Task 2: Add secure artifact primitives

Dependencies: Task 1.

Files:

- Create: `extensions/async/artifacts.ts`
- Create: `tests/asyncArtifacts.test.ts`

- [ ] Step 1: Write failing artifact tests.

Cover:

```ts
it("creates the artifact root and run directory with mode 0700");
it("writes lifecycle files with mode 0600 by atomic replacement");
it("publishes result.json atomically without replacing a winner");
it("lets one of two concurrent publishers win and lets the loser read it");
it("cleans temporary files after successful and failed publication");
it("rejects symlinked roots, run directories, and artifact files");
it("rejects group-writable, other-writable, or foreign-owned paths");
it("rejects paths outside the canonical artifact root");
it("rejects non-regular files and oversized files before JSON parsing");
it("enforces 4 MiB launch, 256 KiB control/status, and 16 MiB result/report limits");
it("caps each diagnostic event line at 1 MiB");
it("scans only validated immediate child directories");
it("derives every lifecycle path from the validated run directory");
```

Use real temporary directories. Skip owner and mode assertions only when the platform cannot expose the relevant metadata. Never follow a symlink during a test setup read.

- [ ] Step 2: Run the focused test and confirm failure.

```bash
cd tests
npx vitest run asyncArtifacts.test.ts
```

Expected: FAIL because artifact functions are absent.

- [ ] Step 3: Implement the artifact API.

Export this surface:

```ts
export interface RunPaths {
  runDir: string;
  launch: string;
  startup: string;
  status: string;
  events: string;
  stdout: string;
  stderr: string;
  report: string;
  result: string;
  traceDir: string;
  controlDir: string;
  startupAck: string;
  startupProceed: string;
  requestsDir: string;
  acknowledgementsDir: string;
  notificationsDir: string;
}

export function resolveArtifactRoot(env?: NodeJS.ProcessEnv): string;
export function createRunDirectory(root: string, runId: string): RunPaths;
export function validateRunDirectory(root: string, runDir: string): RunPaths;
export function writePrivateJsonAtomic(path: string, value: object): void;
export function publishPrivateJsonNoReplace(
  path: string,
  value: object,
): "published" | "exists";
export function readValidatedJson<T>(spec: ArtifactReadSpec<T>): T;
export function appendDiagnosticEvent(paths: RunPaths, event: object): void;
export function scanRunDirectories(root: string): RunPaths[];
export function removeAtomicTemps(paths: RunPaths): void;
```

Use same-directory temporary files. For replacement, write and close the temporary file before rename. For no-replace publication, write and close the temporary file, create the destination with a same-filesystem hard link, and unlink the temporary file. Treat `EEXIST` as a race loss. Reject any no-replace fallback that exposes a partial destination.

Use `lstat`, canonical containment, owner UID, mode, regular-file, and size checks before reads. Open with no-follow flags where Node and the platform expose them. Do not accept caller-supplied artifact paths from launch or control records.

- [ ] Step 4: Run focused and existing persistence tests.

```bash
cd tests
npx vitest run asyncArtifacts.test.ts persistArtifacts.test.ts
```

Expected: PASS.

- [ ] Step 5: Commit the artifact stage.

```bash
git add extensions/async/artifacts.ts tests/asyncArtifacts.test.ts
git commit -m "Add secure async artifact primitives"
```

## Task 3: Prove process identity and complete process-group cleanup

Dependencies: Tasks 1 and 2.

Files:

- Create: `extensions/async/process.ts`
- Create: `tests/asyncProcess.test.ts`
- Modify: `extensions/observability.ts`
- Modify: `tests/observability.test.ts`

- [ ] Step 1: Write failing identity and group tests.

Cover:

```ts
it("captures an OS process start time instead of using launch wall time");
it("returns dead when the PID is absent");
it("returns unknown when start time cannot be read");
it("rejects a reused PID whose start time differs");
it("rejects an instance ID mismatch even when PID and start time match");
it("enumerates non-zombie members of one POSIX process group");
it("records member PID and start time snapshots while the verified leader is live");
it("never calls the signal dependency when identity is unknown");
it("refuses TERM when any current member is absent from the trusted snapshot");
it("refuses TERM when any member PID has a different start time");
it("waits for natural group exit before sending SIGTERM");
it("re-enumerates and revalidates every surviving member before delayed SIGKILL");
it("refuses SIGKILL when membership or a start time changed after TERM");
it("sends SIGKILL only after the configured TERM interval");
it("returns observed only after the group is empty");
it("returns unknown with cleanupPending when enumeration or signaling fails");
it("reports unsupported proof on non-POSIX platforms");
it("cleans a descendant that outlives its direct parent");
```

The last case must spawn a real local fixture process on POSIX. The fixture exits its direct parent while one descendant remains in the same process group.

- [ ] Step 2: Run the focused tests and confirm failure.

```bash
cd tests
npx vitest run asyncProcess.test.ts observability.test.ts
```

Expected: FAIL for the new process API.

- [ ] Step 3: Implement identity and cleanup proof.

Export:

```ts
export type IdentityState = "verified" | "dead" | "unknown";

export interface ProcessGroupMember {
  pid: number;
  startTimeMs: number;
}

export interface TrustedGroupSnapshot {
  processGroupId: number;
  capturedAt: number;
  members: ProcessGroupMember[];
}

export interface GroupCleanupResult {
  terminalProof: "observed" | "unknown-child-fate";
  processFate: "ended" | "unknown";
  cleanupPending: boolean;
  members: ProcessGroupMember[];
  diagnostic?: string;
}

export function captureProcessIdentity(
  pid: number,
  instanceId: string,
): Promise<ProcessIdentity>;
export function verifyProcessIdentity(
  expected: ProcessIdentity,
  observedInstanceId: string,
): Promise<IdentityState>;
export function enumerateProcessGroup(
  processGroupId: number,
): Promise<ProcessGroupMember[]>;
export function refreshOwnedGroupSnapshot(
  child: ChildIdentity,
  heldChild: ChildProcess,
): Promise<TrustedGroupSnapshot>;
export function verifyPersistedGroup(
  child: ChildIdentity,
  snapshot: TrustedGroupSnapshot,
): Promise<IdentityState>;
export function signalVerifiedProcessGroup(
  child: ChildIdentity,
  snapshot: TrustedGroupSnapshot,
  signal: NodeJS.Signals,
): Promise<"sent" | "empty" | "unknown">;
export function terminateVerifiedProcessGroup(
  child: ChildIdentity,
  snapshot: TrustedGroupSnapshot,
  options?: ProcessCleanupOptions,
): Promise<GroupCleanupResult>;
export function finishOwnedProcessGroup(
  child: ChildIdentity,
  snapshot: TrustedGroupSnapshot,
  options?: ProcessCleanupOptions,
): Promise<GroupCleanupResult>;
```

Use actual OS start time as the durable identity value. A liveness probe can report dead, but it cannot report verified without start-time and instance-ID agreement. While the verified child leader is live, the runner can refresh a trusted snapshot from its held `ChildProcess`, captured child identity, and current group enumeration. Persist that snapshot in status.

Before every group signal, enumerate the group again and verify that each current PID and start time matches the trusted snapshot. An empty group needs no signal, and trusted members that already exited do not block cleanup. A new member, changed start time, failed enumeration, or instance mismatch makes the signal disposition unknown and blocks the signal. Repeat the full enumeration and member verification before delayed `SIGKILL`; do not reuse the `SIGTERM` decision. After direct child close, use the last trusted snapshot, wait one second, apply the verified TERM and KILL sequence when safe, and verify emptiness for one second. Exclude zombies. Return unknown proof when any verification, signaling, or final absence check is uncertain.

Keep `parseSessionCost`, `parseTurnBanner`, `parseTraceStatus`, and stderr filtering behavior unchanged in `observability.ts`. Remove process identity decisions that compare PID start time with `RunMeta.startedAt`.

- [ ] Step 4: Run focused tests.

```bash
cd tests
npx vitest run asyncProcess.test.ts observability.test.ts
```

Expected: PASS, including the POSIX descendant test on macOS and Linux.

- [ ] Step 5: Commit process proof.

```bash
git add extensions/async/process.ts extensions/observability.ts \
  tests/asyncProcess.test.ts tests/observability.test.ts
git commit -m "Verify async process-group cleanup"
```

## Task 4: Implement launch creation and the startup handshake

Dependencies: Tasks 1 through 3.

Files:

- Create: `extensions/async/launcher.ts`
- Create: `tests/asyncLauncher.test.ts`
- Create: `tests/helpers/async-test-kit.ts`

- [ ] Step 1: Write failing launcher tests.

Inject filesystem, spawn, clock, random, process-identity, and sleep dependencies. Cover every boundary:

```ts
it("resolves Node from process.execPath when it is executable");
it("resolves Jiti from the package, Pi package, Pi entry, and global sibling");
it("fails before spawn when cwd, Node, Jiti, root, or run directory is invalid");
it("writes launch.json and launching status before detached spawn");
it("writes only the pre-generated instance ID in pre-spawn launching status");
it("passes only launch path, digest, and runner instance ID to the runner");
it("validates ready run, owner, digest, identity, and a 256-bit token");
it("writes startup acknowledgement and waits for matching acknowledged state");
it("writes startup proceed as the durable commit point");
it("returns only after startup proceed exists");
it("never authorizes Swival before acknowledged startup");
it("rolls back a verified runner before proceed on cancellation or timeout");
it("does not signal when pre-commit runner identity is uncertain");
it("returns a start error for death before proceed");
it("returns run ID plus an indeterminate warning after proceed observation fails");
it("warns when sessionManager reports an unpersisted session");
it("never serializes environment values in launch or diagnostics");
```

Also inject failures at run-directory creation, launch write, initial status write, spawn, missing PID, process identity capture, ready read, acknowledgement write, acknowledged read, and proceed write.

- [ ] Step 2: Run the launcher test and confirm failure.

```bash
cd tests
npx vitest run asyncLauncher.test.ts
```

Expected: FAIL because launcher functions are absent.

- [ ] Step 3: Implement the launcher.

Export:

```ts
export interface DurableLaunchInput {
  artifactRoot: string;
  ownerSessionId: string;
  ownerSessionPersisted: boolean;
  agent: string;
  task: string;
  cwd: string;
  args: string[];
}

export interface DurableLaunchResult {
  runId: string;
  artifactDir: string;
  warning?: string;
}

export function resolveNodeExecutable(execPath?: string): string;
export function resolveJitiCli(): string | undefined;
export function launchDurableRun(
  input: DurableLaunchInput,
  deps?: DurableLauncherDeps,
): Promise<DurableLaunchResult>;
```

Generate at least 128 random bits for the run ID and runner instance ID. The runner generates the separate 256-bit startup token. Write `launch.json` and the `LaunchingStatusRecordV1` variant as private atomic files. That initial status contains the intended runner instance ID but no PID or OS start time. Spawn Node detached with Jiti and `extensions/async/runner.ts`, redirect runner diagnostics to the run's stderr file until the runner takes over, and inherit the current environment without persisting it. The runner writes the first `RunnerOwnedStatusRecordV1` only after it captures its PID and OS start time and publishes `ready`.

Capture the spawned runner's OS start time immediately. For pre-commit rollback, require the spawn-owned child handle, expected instance ID, and captured start time. If identity cannot be established, signal nothing and wait for the runner's own handshake timeout to exit. Never turn failure to observe post-proceed progress into a rollback.

- [ ] Step 4: Run launcher and artifact tests.

```bash
cd tests
npx vitest run asyncLauncher.test.ts asyncArtifacts.test.ts asyncProcess.test.ts
```

Expected: PASS.

- [ ] Step 5: Commit the launcher stage.

```bash
git add extensions/async/launcher.ts tests/asyncLauncher.test.ts \
  tests/helpers/async-test-kit.ts
git commit -m "Add durable runner startup handshake"
```

## Task 5: Build the detached runner and terminal publication path

Dependencies: Tasks 1 through 4.

Files:

- Create: `extensions/async/runner.ts`
- Create: `tests/asyncRunner.test.ts`
- Create: `tests/helpers/fake-swival.mjs`

- [ ] Step 1: Add a configurable local fake Swival executable.

The helper must accept normal Swival arguments and use environment-free command-line fixture options after `--` to select behavior. It must support:

```text
success with or without review rounds
report outcome failed
report outcome error
nonzero exit
missing report
malformed report
unknown report outcome
hang until signaled
spawn a same-group descendant
exit direct parent while descendant remains
write controlled stdout and stderr
stop at named handshake and terminal-write fault boundaries
```

It must not read credentials, call a provider, or access the network.

- [ ] Step 2: Write failing runner tests.

Run the runner in a separate process through Jiti. Cover:

```ts
it("validates root, run directory, launch schema, owner, digest, and cwd");
it("writes ready with runner identity and a 256-bit startup token");
it("rejects mismatched ack fields and exits without spawning Swival");
it("writes acknowledged only for the matching token");
it("does not spawn Swival until startup-proceed is valid");
it("makes the live runner the sole status writer");
it("serializes heartbeat and lifecycle status writes through one queue");
it("spawns Swival detached in a separate process group");
it("captures child PID, PGID, start time, instance ID, and command digest");
it("refreshes trusted group snapshots only while the verified leader is live");
it("revalidates every member before each TERM or KILL signal");
it("redirects complete stdout and stderr to private artifact files");
it("uses umask 077 and explicit modes for streams, report, trace, and lifecycle files");
it("preserves exact direct-child exit code and signal from close");
it("maps all public report outcomes through protocol mapping");
it("waits for and cleans the complete process group before normal result");
it("marks cleanup unknown and fails when group proof cannot complete");
it("finishes stream handling before reading report and publishing result");
it("publishes result before terminal status");
it("uses atomic no-replace result publication");
it("reads the winning result when another publisher wins");
it("writes terminal failed status with result-unavailable diagnostics when result write fails");
it("appends terminal events only after authoritative artifacts and ignores event failures");
it("enforces timeoutMs with verified TERM, KILL, and group cleanup");
it("does not persist inherited environment values or unbounded command diagnostics");
```

- [ ] Step 3: Run the runner tests and confirm failure.

```bash
cd tests
npx vitest run asyncRunner.test.ts
```

Expected: FAIL because runner execution is absent.

- [ ] Step 4: Implement runner startup and the serialized state queue.

Use one promise chain or explicit async queue for all status mutations:

```ts
interface RunnerStateQueue {
  update(mutator: (current: StatusRecordV1) => StatusRecordV1): Promise<void>;
  flush(): Promise<void>;
}

export function createRunnerStateQueue(
  paths: RunPaths,
  initial: StatusRecordV1,
): RunnerStateQueue;
```

The runner must set `umask(0o077)`, validate the immutable launch and expected digest before writing `ready`, and create every directory or file with the required private mode. It must time out waiting for acknowledgement and proceed. It must never start Swival before a valid proceed record exists.

- [ ] Step 5: Implement Swival ownership and terminal commitment.

Follow this exact order:

```text
1. Observe direct child close with exact code and signal.
2. Enumerate, stop, and verify the complete Swival process group.
3. Finish stdout and stderr file handling.
4. Read and validate report.json.
5. Map the logical outcome.
6. Publish result.json without replacement.
7. Write terminal status.json atomically.
8. Append a terminal event best effort.
9. Exit the runner.
```

A successful report cannot override failed cleanup proof. An accepted interrupt can produce `stopped` only after verified group absence. Exit zero plus missing, malformed, or unknown report produces `completed`, a `reportHealth` warning, and stdout fallback. A result-write failure produces terminal `failed` status with bounded `result-unavailable` diagnostics and artifact references.

- [ ] Step 6: Run runner, process, and protocol tests.

```bash
cd tests
npx vitest run asyncRunner.test.ts asyncProcess.test.ts asyncProtocol.test.ts
```

Expected: PASS.

- [ ] Step 7: Commit the runner stage.

```bash
git add extensions/async/runner.ts tests/asyncRunner.test.ts \
  tests/helpers/fake-swival.mjs
git commit -m "Run Swival through detached durable owner"
```

## Task 6: Add durable interrupt controls

Dependencies: Task 5.

Files:

- Create: `extensions/async/control.ts`
- Create: `tests/asyncControl.test.ts`
- Modify: `extensions/async/runner.ts`
- Modify: `tests/asyncRunner.test.ts`

- [ ] Step 1: Write failing control tests.

Cover:

```ts
it("publishes an interrupt request atomically without replacement");
it("requires exact owner session and expected runner instance");
it("rejects stale, malformed, oversized, symlinked, or cross-run requests");
it("discovers requests through watch and fallback polling");
it("serializes running to interrupting before acknowledgement");
it("writes acknowledgement before signaling the child group");
it("signals only a verified child identity and fully matched member snapshot");
it("revalidates every member immediately before TERM and delayed KILL");
it("refuses escalation after process-group ID reuse or membership change");
it("escalates TERM to KILL after five seconds and verifies emptiness");
it("deduplicates requests without restarting escalation timers");
it("acknowledges terminal requests as already-terminal");
it("lets natural completion win an interrupt race");
it("returns acknowledged when the runner writes a matching ack");
it("returns durably queued when the short ack wait expires");
it("never claims a signal was sent without runner acknowledgement");
```

- [ ] Step 2: Run focused tests and confirm failure.

```bash
cd tests
npx vitest run asyncControl.test.ts asyncRunner.test.ts
```

Expected: FAIL for durable control behavior.

- [ ] Step 3: Implement extension-side control publication.

Export:

```ts
export function queueInterrupt(
  paths: RunPaths,
  input: QueueInterruptInput,
): Promise<{ requestId: string; disposition: "acknowledged" | "queued" }>;
export function readInterruptAcknowledgement(
  paths: RunPaths,
  requestId: string,
): InterruptAckV1 | undefined;
```

Use at least 128 random bits for request IDs. Validate current durable state and exact ownership before publication. Wait briefly for a matching acknowledgement. Do not signal from this function.

- [ ] Step 4: Implement runner-side request consumption.

Export:

```ts
export function watchInterruptRequests(
  paths: RunPaths,
  context: RunnerControlContext,
): () => void;
```

Process requests on the runner's serialized state queue. Record handled request IDs. Repeated valid requests must return the prior disposition without new timers or signals.

- [ ] Step 5: Run control and runner tests.

```bash
cd tests
npx vitest run asyncControl.test.ts asyncRunner.test.ts asyncProcess.test.ts
```

Expected: PASS.

- [ ] Step 6: Commit durable controls.

```bash
git add extensions/async/control.ts extensions/async/runner.ts \
  tests/asyncControl.test.ts tests/asyncRunner.test.ts
git commit -m "Add durable async interrupts"
```

## Task 7: Reconcile stale runs without uncertain signaling

Dependencies: Tasks 1 through 6.

Files:

- Create: `extensions/async/reconcile.ts`
- Create: `tests/asyncReconcile.test.ts`

- [ ] Step 1: Write a table-driven failing reconciliation suite.

Cover every decision row and race:

```ts
it("repairs nonterminal status from a valid immutable result after runner death");
it("does not repair status when result exists but the verified runner is still live");
it("preserves terminal result-unavailable failed status");
it("leaves a verified live runner with fresh heartbeat unchanged");
it("derives unresponsive health for a verified live stale runner without writing status");
it("does not trust a live PID with wrong start time or instance ID");
it("terminates a dead runner's verified live child group before synthetic result");
it("synthesizes runner-lost when the dead runner has no child group");
it("signals nothing and records unknown child fate for uncertain child identity");
it("honors a valid pending interrupt and synthesizes stopped after verified cleanup");
it("synthesizes startup-abandoned before proceed");
it("reconciles committed work after proceed");
it("quarantines corrupt identity data and signals nothing");
it("does not overwrite an existing result");
it("writes terminal failed status when synthetic result publication fails");
it("bounds reconciliation result-unavailable diagnostics and artifact references");
it("lets two reconcilers race and makes the loser adopt the winner");
it("continues cleanup reconciliation for terminal cleanupPending status");
it("marks post-reboot dead identities failed and never restarts Swival");
it("ignores diagnostic event-log corruption");
```

For each case, assert whether status changed, whether result was published, the exact terminal proof, process fate, cleanup flag, reason code, and signal calls.

- [ ] Step 2: Run the reconciliation test and confirm failure.

```bash
cd tests
npx vitest run asyncReconcile.test.ts
```

Expected: FAIL because the reconciler is absent.

- [ ] Step 3: Implement one-run and session-owned reconciliation.

Export:

```ts
export interface ReconcileResult {
  status: StatusRecordV1 | undefined;
  result?: ResultRecordV1;
  repaired: boolean;
  quarantined: boolean;
  derivedHealth?: "unresponsive";
}

export function reconcileRun(
  paths: RunPaths,
  ownerSessionId: string,
  deps?: ReconcileDeps,
): Promise<ReconcileResult>;
export function reconcileOwnedRuns(
  artifactRoot: string,
  ownerSessionId: string,
  deps?: ReconcileDeps,
): Promise<ReconcileResult[]>;
```

Read and validate any result first, then verify runner identity before deciding whether status can be repaired. A valid result is the terminal decision, but a verified live runner remains the sole status writer during the result-before-status publication window. Return the result in the derived view without writing status. Repair status from the result only after runner death is verified. Report a stale heartbeat as derived health only.

If the runner is dead, verify the child leader or every current group member against the last persisted snapshot before signaling. Apply pending interrupt intent only after full request validation. Publish synthetic results with no-replace semantics. A race loser reads the winner and repairs status to match. If synthetic result publication fails after runner death is verified, write terminal `failed` status with bounded `result-unavailable` diagnostics and artifact references so the run cannot remain active indefinitely. Quarantine corrupt or untrusted identities and signal nothing.

- [ ] Step 4: Run reconciliation, control, and process tests.

```bash
cd tests
npx vitest run asyncReconcile.test.ts asyncControl.test.ts asyncProcess.test.ts
```

Expected: PASS.

- [ ] Step 5: Commit reconciliation.

```bash
git add extensions/async/reconcile.ts tests/asyncReconcile.test.ts
git commit -m "Reconcile stale durable runs"
```

## Task 8: Restore session-owned runs and serve durable status and resume

Dependencies: Task 7.

Files:

- Create: `extensions/async/tracker.ts`
- Create: `tests/asyncTracker.test.ts`
- Modify: `extensions/observability.ts`
- Modify: `tests/observability.test.ts`

- [ ] Step 1: Write failing tracker tests.

Cover:

```ts
it("restores only runs with an exact canonical owner session ID");
it("attaches run and status watchers and a five-second safety sweep");
it("falls back to bounded polling when watch is unavailable or coalesced");
it("reconciles on restore, watcher wake, safety sweep, and explicit refresh");
it("replaces session-bound state on new, fork, and resume session_start events");
it("disposes watchers and timers without stopping committed runners");
it("reports active launching, running, interrupting, and cleanupPending runs");
it("does not treat stale live heartbeat as terminal");
it("loads status progress, proof strength, process warnings, report, and cost");
it("requires terminal logical state before resume");
it("reads bounded output from result, report, then stdout in that order");
it("includes reviewer feedback and result-unavailable diagnostics");
it("rejects another session's status, resume, and interrupt requests");
```

- [ ] Step 2: Run tracker tests and confirm failure.

```bash
cd tests
npx vitest run asyncTracker.test.ts observability.test.ts
```

Expected: FAIL because tracker functions are absent.

- [ ] Step 3: Implement the tracker and durable views.

Export:

```ts
export interface DurableRunView {
  paths: RunPaths;
  status: StatusRecordV1;
  result?: ResultRecordV1;
  derivedHealth?: "unresponsive";
}

export interface DurableRunTracker {
  restore(): Promise<void>;
  refresh(runId?: string): Promise<void>;
  get(runId: string): DurableRunView | undefined;
  listOwned(): DurableRunView[];
  listDrainBlocking(): DurableRunView[];
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export function createDurableRunTracker(
  artifactRoot: string,
  ownerSessionId: string,
  deps?: TrackerDeps,
): DurableRunTracker;
export function formatDurableStatus(view: DurableRunView): string;
export function loadDurableResume(view: DurableRunView): Promise<ResumePayload>;
```

Watch validated paths only. Reconcile before each explicit `status`, `resume`, or `interrupt` view. Bound report, stdout, stderr, and trace reads. Preserve existing progress fields where durable artifacts provide them.

- [ ] Step 4: Run tracker and observability tests.

```bash
cd tests
npx vitest run asyncTracker.test.ts observability.test.ts
```

Expected: PASS.

- [ ] Step 5: Commit restoration and durable reads.

```bash
git add extensions/async/tracker.ts extensions/observability.ts \
  tests/asyncTracker.test.ts tests/observability.test.ts
git commit -m "Restore session-owned durable runs"
```

## Task 8A: Extract and preserve the legacy adapter before cutover

Dependencies: Tasks 3 and 8. This task must commit before Tasks 9 and 10 replace notifier and runtime paths.

Files:

- Create: `extensions/async/legacy.ts`
- Create: `tests/asyncLegacy.test.ts`
- Modify: `extensions/runtime.ts`
- Modify: `extensions/notify.ts`
- Modify: `tests/asyncNotify.test.ts`
- Modify: `tests/extensionWiring.test.ts`

- [ ] Step 1: Write failing legacy adapter tests before moving current readers.

Cover every supported legacy state:

```ts
it("reads completed legacy success, rejection, error, failure, and stop");
it("reads spawn-error.txt without inferring success");
it("uses a legacy report for output but not missing exit proof");
it("keeps a current-process legacy listener active");
it("identity-checks a live legacy group before extension-side interrupt");
it("signals nothing for uncertain legacy identity");
it("records legacy-owner-lost when a process disappears without completed.json");
it("preserves legacy files without rewriting or deleting them");
it("keeps legacy status, resume, and notification behavior available");
```

Capture the current compatibility behavior from `runtime.ts` and `notify.ts` before deleting or redirecting any old reader. Use existing `run-meta.json`, `completed.json`, `spawn-error.txt`, report, stdout, and stderr fixtures.

- [ ] Step 2: Run legacy and current wiring tests and confirm the new module is absent.

```bash
cd tests
npx vitest run asyncLegacy.test.ts asyncNotify.test.ts extensionWiring.test.ts
```

Expected: FAIL only because `extensions/async/legacy.ts` and its explicit API do not exist. Existing legacy behavior remains green.

- [ ] Step 3: Implement the non-destructive adapter.

Export:

```ts
export type LegacyRunView = {
  kind: "legacy";
  runId: string;
  ownerSessionId?: string;
  artifactDir: string;
  state: "running" | "completed" | "failed" | "stopped" | "unknown";
  exitCode: number | null;
  output?: string;
  reviewerFeedback?: string;
  warning?: string;
};

export function loadLegacyRun(
  artifactRoot: string,
  runId: string,
): Promise<LegacyRunView | undefined>;
export function reconcileLegacyRun(
  view: LegacyRunView,
  deps?: LegacyDeps,
): Promise<LegacyRunView>;
export function interruptLegacyRun(
  view: LegacyRunView,
  ownerSessionId: string,
  deps?: LegacyDeps,
): Promise<LegacyInterruptResult>;
export function registerCurrentProcessLegacyRun(
  entry: LegacyLiveRunEntry,
): () => void;
```

Move legacy metadata parsing, completion derivation, direct-spawn listeners, and the narrow extension-side signaling exception behind these names. The legacy signal path still requires observed start-time identity and current-process ownership; uncertain identity blocks signaling. Migration must not rewrite legacy artifacts.

- [ ] Step 4: Route existing legacy behavior through the adapter without durable cutover.

Keep current status, resume, interrupt, notification, and listener tests green through adapter calls. Do not route new launches to the durable runner in this task. This commit establishes compatibility before later tasks remove new-run dependence on `asyncRuns` and direct child listeners.

- [ ] Step 5: Run legacy, notification, and wiring tests.

```bash
cd tests
npx vitest run asyncLegacy.test.ts asyncNotify.test.ts extensionWiring.test.ts
```

Expected: PASS with unchanged current behavior and no destructive artifact migration.

- [ ] Step 6: Commit the adapter before cutover.

```bash
git add extensions/async/legacy.ts extensions/runtime.ts extensions/notify.ts \
  tests/asyncLegacy.test.ts tests/asyncNotify.test.ts \
  tests/extensionWiring.test.ts
git commit -m "Extract legacy async artifact adapter"
```

## Task 9: Replace completion markers with acknowledged notification replay

Dependencies: Tasks 8 and 8A.

Files:

- Modify: `extensions/notify.ts`
- Modify: `tests/asyncNotify.test.ts`

- [ ] Step 1: Replace legacy notifier tests with failing durable tests.

Cover:

```ts
it("derives notices from terminal result or result-unavailable status only");
it("never reads events.jsonl as notification authority");
it("derives deterministic notice keys from result or terminal status digest");
it("scans getEntries custom_message history for persisted swival-notify keys");
it("treats history matches as acknowledged before replay");
it("claims one delivery with a short durable lease");
it("lets an expired lease be reclaimed after restart");
it("batches clean completions for 1.5 seconds");
it("delivers failed, rejected, error, and stopped notices immediately");
it("includes status, agent, run ID, and artifact path but no task output");
it("requires exact custom type, session, batch ID, and notice-key set on message_end");
it("does not acknowledge when message_end fires before the entry appears in history");
it("acknowledges only after getSessionEntries returns the exact custom_message");
it("writes an atomic per-run acknowledgement after history persistence");
it("replays when a crash occurs before message persistence");
it("reduces duplicates when history persisted but acknowledgement did not");
it("permits at-least-once duplicate delivery in the documented crash window");
it("never acknowledges another session's notice");
it("retains Task 8A legacy completion notification behavior");
```

Use `custom_message` entries shaped like Pi's `SessionManager.getEntries()` result. Remove assertions for `notified.json`, run-ID-only deduplication, and `completed.json` authority.

- [ ] Step 2: Run notifier tests and confirm failure.

```bash
cd tests
npx vitest run asyncNotify.test.ts
```

Expected: FAIL against the old notifier.

- [ ] Step 3: Implement durable notice leases and acknowledgements.

Retain `createSwivalNotifier`, but change its dependencies and inputs:

```ts
export interface SwivalNotifierDeps {
  currentSessionId: string;
  getSessionEntries: () => readonly unknown[];
  batchWindowMs?: number;
  leaseMs?: number;
  now?: () => number;
}

export interface SwivalNotifier {
  reconcile(
    durableViews: readonly DurableRunView[],
    legacyViews: readonly LegacyRunView[],
  ): Promise<void>;
  dispose(): void;
}
```

Store lease and acknowledgement records under each run's `control/notifications/` directory. Include the notice key in filenames only after validating it as a lowercase SHA-256 hex digest. Use atomic no-replace lease claims. Allow takeover only after a validated lease expires.

Treat `message_end` as an observation trigger, not persistence proof. Pi's installed `dist/core/cache-stats.d.ts` states that `message_end` fires before persistence. After an exact custom type, session, batch ID, and notice-key set match, query `getSessionEntries()` for the exact `custom_message` entry. Write per-run acknowledgement files only after history contains that entry. If the event arrives before persistence, keep the delivery unacknowledged and retry history verification through a bounded timer or the next reconciliation scan. Add a package-runtime regression test so a future Pi ordering change cannot weaken acknowledgement.

- [ ] Step 4: Run notifier and tracker tests.

```bash
cd tests
npx vitest run asyncNotify.test.ts asyncTracker.test.ts
```

Expected: PASS.

- [ ] Step 5: Commit notification replay.

```bash
git add extensions/notify.ts tests/asyncNotify.test.ts
git commit -m "Replay acknowledged durable notices"
```

## Task 10: Wire durable launch, controls, restoration, and headless draining

Dependencies: Tasks 8A and 9.

Files:

- Modify: `extensions/runtime.ts`
- Modify: `tests/agentEndDrain.test.ts`
- Modify: `tests/extensionWiring.test.ts`

- [ ] Step 1: Rewrite drain unit tests to use durable views.

Change the drain predicate to block on:

```ts
const DRAIN_STATES = new Set([
  "launching",
  "running",
  "interrupting",
]);

function blocksAgentEnd(view: DurableRunView): boolean {
  return DRAIN_STATES.has(view.status.state) || view.status.cleanupPending;
}
```

Test prompt wake, bounded polling, work added during drain, another session, interactive bypass, cleanup-pending terminal work, 30-minute timeout, and listener cleanup. Assert that timeout does not signal any process.

- [ ] Step 2: Rewrite extension wiring tests around durable dependencies.

Inject launcher, tracker, reconciler, notifier, and control dependencies rather than mocking direct `spawn("swival")`. Cover:

```ts
it("uses getSessionId rather than getSessionFile as canonical owner");
it("warns but permits async launch for an in-memory session");
it("restores owned runs on session_start and execute fallback activation");
it("disposes old tracker and notifier before session replacement");
it("leaves committed runners alive on session_shutdown");
it("routes async launch through launchDurableRun");
it("routes status and resume through durable validated views");
it("queues interrupt intent and never signals in runtime.ts");
it("rejects exact-owner mismatches for all controls");
it("drains persisted work after extension recreation");
it("wakes drain on tracker changes and polls as fallback");
it("keeps interactive agent_end nonblocking");
it("does not import or register pi-subagents integration");
```

Keep existing sync, collision, project-agent confirmation, preflight, and output tests intact.

- [ ] Step 3: Run wiring tests and confirm failure.

```bash
cd tests
npx vitest run agentEndDrain.test.ts extensionWiring.test.ts
```

Expected: FAIL against in-memory `asyncRuns` wiring.

- [ ] Step 4: Refactor `runtime.ts` without changing synchronous dispatch.

Perform these exact changes:

1. Keep `buildSwivalArgs`, sync report parsing, sync trace tailing, sync rendering, chain, parallel, preflight, cache, output, and collision behavior in place.
2. Replace new-run calls to `runSingleSwivalAsync` with `launchDurableRun`.
3. Build the launch arguments with the same agent lookup, reviewer requirement, preflight, cache preparation, cwd, trace, and task separator used today.
4. Use `ctx.sessionManager.getSessionId()` as owner and `ctx.sessionManager.isPersisted()` for the warning flag.
5. Replace control-action reads with tracker refresh and durable view formatting, then fall back to Task 8A legacy views when no durable record exists.
6. Replace direct interrupt signaling with `queueInterrupt`, while retaining `interruptLegacyRun` for validated legacy records.
7. Replace `asyncRuns.values()` draining with `tracker.listDrainBlocking()`, plus current-process legacy entries that the adapter still owns.
8. Restore tracker and notifier during `session_start`, replace both on session change, and dispose only extension resources on `session_shutdown`.
9. Keep only the Task 8A compatibility registry for legacy direct-spawn listeners. New launches must never enter it.

Delete new-run dependence on `RunMeta`, `AsyncRunEntry`, `attachAsyncRunListeners`, `runSingleSwivalAsync`, `loadRunState`, and direct `killProcessGroup`. Keep only the Task 8A adapter's explicitly named legacy readers, listeners, and identity-checked interrupt exception. Status, resume, notification, and control dispatch must try the durable protocol first and then the non-destructive legacy adapter.

- [ ] Step 5: Run wiring, drain, dispatch, and sync result tests.

```bash
cd tests
npx vitest run agentEndDrain.test.ts extensionWiring.test.ts \
  dispatchGuards.test.ts buildSwivalArgs.test.ts buildParallelSummary.test.ts \
  summarizeReport.test.ts
```

Expected: PASS.

- [ ] Step 6: Commit extension wiring.

```bash
git add extensions/runtime.ts tests/agentEndDrain.test.ts \
  tests/extensionWiring.test.ts
git commit -m "Wire durable async execution into Pi"
```

## Task 11: Add safe retention after durable and legacy cutover

Dependencies: Task 10. The legacy adapter already exists from Task 8A.

Files:

- Modify: `extensions/async/artifacts.ts`
- Modify: `tests/asyncArtifacts.test.ts`
- Modify: `tests/asyncLegacy.test.ts`
- Modify: `extensions/runtime.ts`

- [ ] Step 1: Write failing retention tests.

Cover:

```ts
it("prunes terminal runs seven days after endedAt only when cleanup is resolved");
it("never age-prunes active or cleanupPending runs");
it("forces stale active runs through reconciliation before deletion");
it("removes orphaned atomic temporary files during eligible pruning");
it("skips symlinks, corrupt entries, non-directories, and paths outside root");
it("retains unacknowledged notifications until normal run retention");
it("does not rewrite or prune legacy artifacts under durable rules");
```

- [ ] Step 2: Run focused tests and confirm failure.

```bash
cd tests
npx vitest run asyncArtifacts.test.ts asyncLegacy.test.ts
```

Expected: FAIL for the new retention rules. Task 8A legacy compatibility tests remain green.

- [ ] Step 3: Implement safe pruning.

Replace mtime-only pruning with validated `endedAt`, terminal state, and cleanup proof. Reconcile stale active durable records before deletion. Delete only a validated durable run directory beneath the validated root. Leave legacy retention behavior non-destructive unless the existing legacy marker rules already make a directory eligible.

- [ ] Step 4: Run retention, legacy, wiring, and notification tests.

```bash
cd tests
npx vitest run asyncArtifacts.test.ts asyncLegacy.test.ts \
  extensionWiring.test.ts asyncNotify.test.ts
```

Expected: PASS.

- [ ] Step 5: Commit retention.

```bash
git add extensions/async/artifacts.ts extensions/runtime.ts \
  tests/asyncArtifacts.test.ts tests/asyncLegacy.test.ts
git commit -m "Prune resolved durable async runs"
```

## Task 12: Prove durability with separate-process integration tests

Dependencies: Tasks 1 through 11.

Files:

- Create: `tests/helpers/async-host.ts`
- Create: `tests/asyncIntegration.test.ts`
- Modify: `tests/helpers/fake-swival.mjs`
- Modify: `tests/helpers/async-test-kit.ts`

- [ ] Step 1: Implement the separate-process host helper.

The host must run through the same resolved Node and Jiti route as production. It must expose file-based test commands for launch, status, resume, interrupt, reconcile, notification acknowledgement, drain, and exit. Each invocation must be a new OS process. Do not simulate Pi restart with `vi.resetModules()`.

The helper input must contain only temporary paths, session IDs, fake Swival behavior, and injected timing. It must reject credentials and provider configuration fields.

- [ ] Step 2: Write the required integration matrix as failing tests.

Implement these exact scenarios from the specification:

```ts
it("completes a normal durable success");
it("maps accepted, completed, rejected, error, failed, and stopped outcomes");
it("continues after the launching extension host exits");
it("supports status, resume, and notification from a recreated host");
it("interrupts through durable control after host recreation");
it("reconciles runner death while a child remains alive");
it("cleans a descendant after direct-child exit");
it("escalates group cleanup and proves emptiness");
it("reconciles runner death before result publication");
it("repairs status when result publication won first");
it("replays notice after delivery before acknowledgement");
it("drains persisted state during headless agent_end");
it("marks simulated reboot runner loss failed without restart");
it("makes one of two reconcilers win a stale run");
it("restores legacy completion and detects legacy owner loss");
```

- [ ] Step 3: Add handshake and terminal fault injection.

Add table-driven subprocess cases that stop the launcher or runner after each boundary:

```text
launch write
initial status write
runner spawn
ready write
ack write
acknowledged write
proceed write
child spawn
child close
process-group proof
stdout/stderr finish
report read
result publish
terminal status write
notification send
message_end before session-history persistence
notification acknowledgement
```

For every boundary, assert the next host can restore, reconcile, or report a bounded explicit failure. Assert no fake Swival child starts before proceed. Include reconciliation-side synthetic result publication failure and require terminal `failed` status with bounded `result-unavailable` diagnostics. Run one package-runtime case that proves `message_end` can precede `SessionManager.getEntries()` persistence and that acknowledgement waits for the exact persisted `custom_message` entry.

- [ ] Step 4: Run the integration suite.

```bash
cd tests
npx vitest run asyncIntegration.test.ts --testTimeout=30000
```

Expected: PASS on supported POSIX systems. Non-POSIX runs must assert unsupported cleanup proof instead of skipping into a false success.

- [ ] Step 5: Run all async-focused tests together to expose leaked processes and timers.

```bash
cd tests
npx vitest run asyncProtocol.test.ts asyncArtifacts.test.ts \
  asyncProcess.test.ts asyncLauncher.test.ts asyncRunner.test.ts \
  asyncControl.test.ts asyncReconcile.test.ts asyncTracker.test.ts \
  asyncNotify.test.ts asyncLegacy.test.ts asyncIntegration.test.ts \
  agentEndDrain.test.ts extensionWiring.test.ts
```

Expected: PASS with no hanging Vitest worker, surviving fake child, leaked watcher, or leaked timer.

- [ ] Step 6: Commit integration proof.

```bash
git add tests/helpers/async-host.ts tests/helpers/fake-swival.mjs \
  tests/helpers/async-test-kit.ts tests/asyncIntegration.test.ts
git commit -m "Test durable async execution across processes"
```

## Task 13: Update user and operator documentation

Dependencies: Task 12.

Files:

- Modify: `README.md`
- Modify: `skills/swival/SKILL.md`
- Modify: `scripts/smoke-test.sh`

- [ ] Step 1: Add a smoke assertion for detached runner loadability.

Extend the smoke test with a fourth layer that resolves Node and Jiti through `extensions/async/launcher.ts`, loads `extensions/async/runner.ts` without starting a run, and confirms no pi-subagents package is needed. Keep the scratch `HOME` and provider-free behavior.

- [ ] Step 2: Update `README.md`.

Document:

- `startup-proceed.json` as the durable start commit.
- The runner and Swival process-group layout.
- Restoration after extension reload and Pi process restart.
- The machine-reboot non-goal and runner-loss reconciliation.
- Durable status, resume, and queued interrupt behavior.
- Exact owner-session isolation through `getSessionId()`.
- Terminal proof, `cleanupPending`, and unknown child fate.
- Terminal status/result notification authority.
- At-least-once notification delivery and durable acknowledgement.
- New protocol artifacts and legacy artifact compatibility.
- Seven-day retention and the cleanup-pending exception.
- Separate-process local tests and the absence of pi-subagents dependencies.
- Continued synchronous behavior and async single-mode restriction.

Replace statements that describe `asyncRuns`, `completed.json`, `notified.json`, session-file ownership, or direct extension-side signaling for new runs.

- [ ] Step 3: Update `skills/swival/SKILL.md`.

Explain what the agent should tell users after launch, including an indeterminate-start warning after commit. Explain that interrupt can be durably queued, that `status` exposes proof and cleanup warnings, that `resume` requires a terminal logical state, and that Pi restart restoration requires the same canonical session. Keep the warning that `subagent_wait` does not manage pi-swival runs.

- [ ] Step 4: Run documentation and smoke checks.

```bash
npm run smoke
npx markdownlint-cli2 README.md skills/swival/SKILL.md \
  docs/superpowers/specs/2026-08-25-durable-swival-runner-design.md \
  docs/superpowers/plans/2026-08-25-durable-swival-runner.md
git diff --check
```

Expected: all commands exit zero.

- [ ] Step 5: Commit documentation.

```bash
git add README.md skills/swival/SKILL.md scripts/smoke-test.sh
git commit -m "Document durable async Swival runs"
```

## Task 14: Run final review, dependency checks, and quality gates

Dependencies: Tasks 1 through 13.

Files:

- Modify only files required by blocking review findings.

- [ ] Step 1: Prove no pi-subagents dependency or artifact coupling exists.

Run:

```bash
rg -n "from .*pi-subagents|require\(.*pi-subagents|DIRS\.async|subagent_wait|SUBAGENT_" \
  extensions tests package.json
```

Expected: no runtime or test dependency. A user-facing documentation string that says `subagent_wait` does not manage pi-swival is permitted.

Run:

```bash
npm ls --all | rg "pi-subagents" && exit 1 || true
```

Expected: no installed package dependency.

- [ ] Step 2: Run focused security and lifecycle tests.

```bash
cd tests
npx vitest run asyncArtifacts.test.ts asyncProcess.test.ts \
  asyncLauncher.test.ts asyncRunner.test.ts asyncControl.test.ts \
  asyncReconcile.test.ts asyncTracker.test.ts asyncNotify.test.ts \
  asyncLegacy.test.ts asyncIntegration.test.ts
```

Expected: PASS.

- [ ] Step 3: Run the full repository gates.

```bash
npm test
npm run smoke
npm run ci
shellcheck scripts/smoke-test.sh skills/swival/scripts/swival-proxy
npx markdownlint-cli2 "**/*.md" "#tests/node_modules"
git diff --check
```

Expected: the original 224 tests plus all new tests pass. Smoke, CI, shellcheck, markdownlint, and whitespace checks pass.

- [ ] Step 4: Run the installed-runtime package-load test explicitly.

```bash
SCRATCH="$(mktemp -d -t pi-swival-final.XXXXXX)"
HOME="$SCRATCH" PI_SWIVAL_ARTIFACT_ROOT="$SCRATCH/artifacts" \
  pi -e "$PWD" -p --no-session >"$SCRATCH/pi.log" 2>&1
! rg "Failed to load extension|extension load error|pi-subagents" "$SCRATCH/pi.log"
rm -rf "$SCRATCH"
```

Expected: Pi loads the extension, skill, prompt, launcher, and runner support without error or provider access.

- [ ] Step 5: Run read-only implementation review and cleanup review.

Review against the specification and this plan. Treat findings as blocking only when they violate correctness, safety, durability, compatibility, or an acceptance criterion. Do not add optional abstractions or unrelated refactors.

- [ ] Step 6: Apply blocking fixes and rerun affected focused tests plus `npm run ci`.

Expected: PASS.

- [ ] Step 7: Verify the final diff and commit any review fixes.

```bash
git status --short
git diff --stat
git diff --check
git add extensions tests README.md skills/swival/SKILL.md scripts/smoke-test.sh
git commit -m "Harden durable async execution"
```

Skip the commit when review produced no changes.

## Specification traceability

| Specification requirement | Planned coverage |
| --- | --- |
| Independent detached Node runner | Tasks 4, 5, 10, 12, 14 |
| Persist launch, startup, status, events, streams, report, result, controls | Tasks 1, 2, 4, 5, 6 |
| Durable startup commit | Tasks 4, 5, 12 |
| Live runner as sole status writer | Tasks 1, 5, 7 |
| Atomic no-replace terminal result | Tasks 2, 5, 7, 12 |
| Exact child exit code and signal | Tasks 5 and 12 |
| Complete process-group cleanup proof | Tasks 3, 5, 6, 7, 12 |
| Result-write failure fallback | Tasks 5, 7, 8, 12 |
| Durable, idempotent interrupt intent | Tasks 6, 7, 10, 12 |
| PID reuse and instance validation | Tasks 3, 4, 6, 7, 11 |
| Stale-run reconciliation and quarantine | Task 7 and Task 12 |
| Session-owned restoration | Tasks 8, 10, 12 |
| Status and bounded resume | Tasks 8 and 10 |
| Persisted headless draining | Tasks 8, 10, 12 |
| Terminal status/result notification authority | Task 9 |
| At-least-once notification acknowledgement and replay | Tasks 9 and 12 |
| Seven-day safe retention | Tasks 2 and 11 |
| Legacy artifact compatibility | Tasks 8A, 10, and 12 |
| Synchronous behavior unchanged | Tasks 10, 12, 14 |
| Machine reboot does not restart work | Tasks 7, 12, 13 |
| No pi-subagents runtime or test dependency | Tasks 4, 12, 13, 14 |
| Documentation and final gates | Tasks 13 and 14 |

## Commit sequence

The intended implementation history is:

```text
1. Define durable async protocol
2. Add secure async artifact primitives
3. Verify async process-group cleanup
4. Add durable runner startup handshake
5. Run Swival through detached durable owner
6. Add durable async interrupts
7. Reconcile stale durable runs
8. Restore session-owned durable runs
8A. Extract legacy async artifact adapter
9. Replay acknowledged durable notices
10. Wire durable async execution into Pi
11. Prune resolved durable async runs
12. Test durable async execution across processes
13. Document durable async Swival runs
14. Harden durable async execution, only if review finds blocking issues
```

Each commit must pass its listed focused tests. Do not squash these boundaries during implementation review because they isolate protocol, process, runner, reconciliation, and integration risk.

## Final acceptance check

Before implementation is declared complete, manually map the final evidence to every acceptance criterion in the approved specification. Record the test name or command that proves each criterion. Do not use catalogue entries, status labels, or intended behavior as proof when a runnable integration test can prove the mechanism.
