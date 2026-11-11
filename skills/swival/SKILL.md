---
name: swival
description: >-
  Delegate tasks to Swival for self-reviewed code changes, sandboxed
  execution, secret-safe operations, cached analysis, local-model
  inference, and A2A agent serving or client usage. Use when a task
  benefits from automated review loops against acceptance criteria,
  filesystem sandboxing, credential encryption, LLM response
  caching, or orchestrating a network of A2A agents.
---

# Swival

Tracked against Swival 1.9.3, LiteLLM 1.106.6, and Python >=3.13,<3.15. The operational test harness uses Python 3.13.

Swival is a coding agent with a reviewer loop, configurable sandboxes, secret encryption, request filtering, and A2A support. Access it from Pi through `swival-subagent`.

## Delegation via swival-subagent

The `swival-subagent` tool dispatches tasks with structured results and error classification. Normal one-shot traces arrive at finalization, not as live tool events. Bundled agents require an installed, configured Swival runtime. Add definitions in `~/.pi/agent/swival-agents/` (user scope) or `.pi/swival-agents/` (project scope). Discovery priority: project > user > bundled. `agentScope` defaults to `user`; project definitions require `"project"` or `"both"`. Project dispatch requests confirmation unless extension options or `PI_SWIVAL_TRUST_PROJECT_AGENTS=1` (or `true`) disable it.

Bundled definitions live at `../../agents/<name>.md` relative to this skill, so the path holds wherever Pi installed the package. Read that file to see an agent's real frontmatter.

### Agent selection

| Agent | Use when |
|-------|----------|
| `self-review-worker` | Implementation, file edits, or artifacts that should pass through `--self-review`; not for review-only tasks |
| `test-runner` | Task has a runnable test command as acceptance criterion (pass `reviewerOverride`) |
| `sandboxed-reviewer` | Read-only review (`selfReview: false`, `commands: none`, `noSkills: true`, `network: provider-only`); requires nono/profile pack. Read-only is prompt-level: base-dir writes are write-through. Explicit false suppresses inherited self-review using the required Swival-only shim. It requires an explicit `sandbox: agentfs` or `sandbox: builtin`; nono, inherited/unspecified sandbox selection, and explicit `network: none` are refused before allocation. Inherited `network = "none"` is rejected by Swival before re-exec. `addDirRo` cannot grant nono startup-shim access. |
| `sandboxed-explorer` | Exploration in a disposable cwd; its fresh AgentFS session does not prevent host writes. Use `sandboxed-reviewer` for read-only reviews |
| `swival` | Simple delegation, no review needed (also the default when agent is omitted) |
| `a2a-coordinator` | Delegate part of a task to a remote A2A agent named in an `a2aConfig` TOML file; requires `network: full` |

Use `auditing-with-swival` for the structured native audit API. Use `swival-worker-briefs` to write task briefs for `self-review-worker`.

### Dispatch examples

`self-review-worker` is a worker with Swival self-review enabled. Use reviewer agents, the `code-review` skill, or the GitHub PR review workflow for review-only tasks.

Single task (generic, no review):

```
swival-subagent with task: "Refactor the auth module"
```

Self-reviewed implementation:

```
swival-subagent with agent: "self-review-worker", task: "Add input validation to cmd/serve.go"
```

Test-as-contract:

```
swival-subagent with agent: "test-runner",
  reviewerOverride: "./run-tests.sh",
  task: "Make the failing tests pass"
```

Exploration requires a disposable cwd containing only files you can discard. Set `cwd` explicitly on the following call. Swival 1.9.3 can permit host-base write-through, including fresh AgentFS sessions.

```
swival-subagent with agent: "sandboxed-explorer",
  task: "Refactor the database layer"
```

Parallel task isolation:

Parallel tasks use separate processes but share the host filesystem. The `tasks` array supports up to 8 tasks, with default concurrency 4 and maximum 8. Only agents with both `files: none` and `commands: none` receive the shared-cwd exemption. Fresh AgentFS sessions and command-name allowlists remain write-capable. Use distinct disposable directories or worktrees for writable tasks.

The following AgentFS example needs distinct, pre-created disposable directories passed through each task's `cwd`. Do not run it unchanged against a shared writable cwd. Fresh sessions separate session state, not host-base writes:

```
swival-subagent with tasks: [
  { agent: "sandboxed-explorer", task: "Refactor parser logic" },
  { agent: "sandboxed-explorer", task: "Refactor tokenizer logic" }
]
```

Git worktree isolation for real filesystem mutations:

```bash
git worktree add -b worker-a .worktrees/worker-a HEAD
git worktree add -b worker-b .worktrees/worker-b HEAD
```

```
swival-subagent with tasks: [
  { agent: "self-review-worker", task: "Implement API", cwd: ".worktrees/worker-a" },
  { agent: "self-review-worker", task: "Implement UI", cwd: ".worktrees/worker-b" }
]
```

Fresh worktrees track committed files only. Untracked dependencies (`node_modules`, `.venv`, `.env`) must be installed or linked before running builds or tests. Worktrees isolate concurrent writes against race conditions, but share `.git` configuration and hooks with the host repository. For bundled and user-scope agents, `pi-swival` validates linked worktrees and passes `--add-dir-ro <common-git-dir>`. This supports read-only Git commands (`status`, `rev-parse`, `diff`) under `network: provider-only`. It exposes shared Git configuration without granting write access through that read-only directory grant.

After tasks finish, commit any uncommitted changes in each worktree, merge the branches, and remove the worktrees:

```bash
git -C .worktrees/worker-a add -A && git -C .worktrees/worker-a commit -m "Implement API"
git merge worker-a
git worktree remove .worktrees/worker-a && git branch -d worker-a
```

Chain (each step gets prior step's output as `{previous}`):

```
swival-subagent with chain: [
  { agent: "swival", task: "Summarize the auth module" },
  { agent: "self-review-worker", task: "Given: {previous}\nAdd input validation." }
]
```

### Async / background execution

Run a long task in the background and return immediately:

```
swival-subagent with agent: "self-review-worker", task: "Refactor the auth module", async: true
```

The tool returns a `runId` containing a timestamp and random suffix. `async: true` is only supported in single-agent mode, not chain/parallel. Reports/default traces use private system temporary scratch; the host runner exports them before `completed.json`, with no artifact-directory sandbox grant. Limits: 16 MiB/report, 4 MiB/trace, 16 trace-directory entries scanned (including rejected names), 64 MiB total; only owned single-link regular files and safe trace basenames are accepted. `transfer-error.txt` records value-free rejection codes; worker exit codes stay unchanged and invalid/missing sandbox reports still fail closed. Default evidence is available only after worker exit; forced kills can discard unexported evidence and oversized traces are dropped, not truncated. Explicit trace destinations remain caller-owned. The runner owns scratch cleanup after launch, with parent cleanup after confirmed termination; abrupt SIGKILL can leave `pi-swival-async-*` directories or incomplete `.tmp` files. There is no scavenger or notification promise. If the runner cannot write a valid terminal marker, a run recovered from disk after a Pi restart reports `unknown` status (and `resume` fails) because liveness is never probed. The real AgentFS gate checks the actual temporary-directory family; macOS evidence is not Linux proof.

Once started, manage it using `action` and `id`:

| Action      | Description |
|-------------|-------------|
| `status`    | Check if running, or get the final outcome if done |
| `resume`    | Get the final answer and reviewer feedback when finished |
| `interrupt` | Stop a run tracked by the same Pi process; recovered PIDs grant no authority |

Use the returned identifier in place of the illustrative value below:
```
swival-subagent with action: "status", id: "swival-run-1716326580000"
```

Async `timeoutMs`, `output`, and `outputMode` are unsupported and rejected before side effects. `providerTimeoutOverride` bounds provider requests, not total runtime. Retrieve completed output with `resume`. `resume` does not restart execution, and live steering is unsupported.

### Paths and output

Ordinary `cwd` and `output` are caller-selected paths, not approved-root restrictions. Relative cwd values resolve from Pi's cwd; per-item cwd overrides the top-level value. Relative output paths resolve from the selected task or step cwd. Output writes occur in Pi, outside the child sandbox, with symlink checks and atomic mode-0600 replacement. These checks provide no confidentiality guarantee.

Synchronous `output` defaults to file-only response metadata; `outputMode: "inline"` also returns the body. Failed chains inline nonempty partial output even in file-only mode. Parallel output belongs on each task; top-level output does not bind parallel results. Chain top-level output applies to the last successful step, or the failing step on failure. Per-step output takes precedence. Reusing output paths can overwrite earlier results. Output-write failures appear in `stderrTail`; check `outputPath` before assuming a file exists.

`maxInlineBytes` counts characters despite its name. Ordinary output has no default inline cap; native output defaults to 65536 characters. Synchronous `timeoutMs` has no ordinary default and applies per process, not to the entire parallel batch or chain.

### Dispatch-time overrides

These top-level parameters override agent frontmatter. Parallel tasks and chain steps accept only `agent`, `task`, `cwd`, `seed`, `output`, and `outputMode`; other overrides remain shared.

| Parameter | Controls |
|-----------|----------|
| `modelOverride` | Model ID |
| `profileOverride` | Named profile from config.toml |
| `providerOverride` | Provider name |
| `baseUrlOverride` | Provider base URL |
| `selfReviewOverride` | Enable/disable self-review |
| `reviewerOverride` | Path to reviewer script |
| `reviewPromptOverride` | Custom review criteria |
| `verifyOverride` | Acceptance criteria file passed to `--verify` |
| `encryptSecretsOverride` | Request secret encryption; false does not unset ambient configuration |
| `maxReviewRoundsOverride` | Review round budget |
| `maxTurnsOverride` | Agent turn limit; upstream one-shot default 250, REPL default 200 |
| `maxOutputTokensOverride` | Output token limit |
| `temperatureOverride` | Sampling temperature |
| `topPOverride` | Nucleus sampling |
| `seedOverride` | Deterministic seed |
| `reasoningEffortOverride` | Reasoning effort level |
| `instructionsFullOverride` | Opt in to full instructions without truncation |
| `networkOverride` | Network policy (`full`, `provider-only`, `none`) |
| `nonoRollbackOverride` | Enable nono atomic rollback snapshots |
| `nonoBlockNetOverride` | Block all outbound network under nono sandbox |
| `commandMiddlewareOverride` | Command run before each tool command |
| `maxOutputKbOverride` | Size cap in KB for tool output |
| `maxOutputLinesOverride` | Line cap for file reads |
| `addDirOverride` | Extra read-write directories (`--add-dir`, single mode only; `[]` clears frontmatter) |
| `addDirRoOverride` | Extra read-only directories (`--add-dir-ro`; replaces configured `allowed_dirs_ro`) |
| `skillsDirOverride` | Additional directories to scan for skills |
| `shareSkills` | Share ambient Pi skills with Swival |
| `subagentsOverride` | Allow Swival to spawn native subagents |
| `cacheOverride` | Request LLM response caching; false does not unset ambient configuration |
| `cacheDirOverride` | Cache directory |
| `a2aConfigOverride` | Path to an A2A TOML config file (single mode only); requires `network: full` |
| `providerTimeoutOverride` | Provider request timeout in seconds (default 900) |
| `initialToolChoiceOverride` | Tool selection for the first model request (`auto`, `required`) |

Swival's `/reasoning` command is REPL-only. Use `reasoningEffortOverride` (or the agent frontmatter `reasoningEffort`) as the Pi equivalent.

## Authoring Agent Definitions

Create a `.md` file in `~/.pi/agent/swival-agents/` with YAML frontmatter:

```yaml
---
name: my-agent
description: What this agent does

# Reviewer loop (pick one or neither)
selfReview: true                  # LLM self-review
reviewer: ./test.sh               # script as reviewer (exit 0 = accept)
reviewPrompt: "Check X and Y"    # criteria for self-review
maxReviewRounds: 5                # round budget
requiresReviewer: true            # dispatcher refuses to spawn without a reviewer

# Sandbox / commands
sandbox: agentfs                  # builtin | agentfs | nono
files: some                       # none | some | all
commands: all                     # all | none | ask | "ls,git,rg"
yolo: true                        # shorthand: files=all, commands=all
nonoRollback: true                # nono only: atomic rollback snapshots
network: provider-only            # full | provider-only | none

# Nested-invocation hygiene (noInstructions is explicit; other listed flags default true)
noInstructions: true
# instructionsFull: true         # mutually exclusive with noInstructions — remove that line if enabled
noMemory: true
noLifecycle: true
noMcp: true
noA2a: true
noHistory: true
noContinue: true
noSubagents: true

# Extra directories
addDir: ["/path1"]                # read+write access
addDirRo: ["/ref/repo"]          # read-only access

# Other
encryptSecrets: true
noReadGuard: true
cache: true
cacheDir: .swival/cache
extraArgs: ["--max-context-tokens", "128000"]
---

System prompt body here (optional).
```

Do not specify `model`, `provider`, or `baseUrl` in agent definitions. Model routing belongs in `~/.config/swival/config.toml`. Use `profileOverride` at dispatch time when a specific profile is needed.

### Agent configs do not inherit

Each agent's frontmatter is independent. There is no base agent, no `extends:` field, and no implicit inheritance from the bundled set. When forking a bundled agent into user or project scope, copy its entire frontmatter. Omitted flags use dispatcher or upstream defaults, not the bundled definition's settings. The trap to watch for:

- `requiresReviewer: true` on `test-runner` is what makes the test-as-contract gate enforceable. Drop it in a fork and the agent will report completion without running the test script.
- The nested-invocation hygiene flags default to disabling lifecycle, MCP, A2A, web search, history, continuation, memory, and native subagents. Frontmatter can opt in; `noWebSearch` emission requires Swival >=1.9.0. `noInstructions` differs: the example disables instructions explicitly; the dispatcher does not disable them by default. The dispatcher enforces `--no-subagents` by default to prevent unbounded subagent recursion. Do not rely on schema defaults, restate the flags you want.
- Project-scope agents cannot preserve the full frontmatter set. For security, `pi-swival` strips execution and sandbox override fields from project-local agents. Stripped fields include `yolo`, `extraArgs`, `profile`, `reviewer`, `verify`, `commandMiddleware`, `nonoProfile`, and `skillsDir`. The sanitizer also strips `provider`, `model`, `baseUrl`, `baseDir`, `addDir`, and `addDirRo`. It removes `a2aConfig` and `allowA2a`, and forces `noA2a: true` and `noWebSearch: true`. It narrows `network` to `none` only. It forces `sandbox: agentfs`, even if frontmatter requests `sandbox: nono`. Fork agents that need these capabilities into user scope (`~/.pi/agent/swival-agents/`).
- Project definitions cannot remove a shadowed bundled or user agent's `requiresReviewer: true`. The dispatcher preserves that requirement, preventing project-local impersonation from dropping the reviewer gate.

When overriding a bundled name in user scope, compare its frontmatter with the bundled definition. Preserve the flags your task needs. A user-scope file in `~/.pi/agent/swival-agents/` shadows the bundled profile of the same name, so an outdated `sandboxed-reviewer` override silently drops later bundled requirements (such as the SecretShield verification rule) unless you keep it aligned.

## Capabilities Reference

### Reviewer loop

Automated review loop that evaluates task output after each answer and retries until acceptance or budget exhaustion.

- Self-review: same model, fresh context evaluates the output
- Test-as-contract: external script gates completion (exit 0 = accept, 1 = retry with stdout as feedback, 2 = reviewer error)
- `--verify FILE`: feeds acceptance criteria to the reviewer
- Default budget: 15 rounds (`maxReviewRounds` overrides)

Self-review and `--reviewer` are mutually exclusive. A `sandboxed-reviewer` dispatch reports claims, not verified facts: before acting on a token-shaped finding (see Secret encryption), confirm the cited `file:line` on the host.

### Filesystem sandbox and network isolation

Swival supports three sandbox backends:

| Mode | Backend | Capabilities |
|------|---------|--------------|
| `builtin` | Application path checks | Fast. Enables standard input prompt delivery. |
| `agentfs` | Overlay and platform sandbox | Host-base writes can pass through. Use a disposable cwd. |
| `nono` | OS kernel (Landlock/Seatbelt) | Kernel isolation. Enables rollback snapshots and network blocking. |

The read-before-write guard prevents overwriting unread files. `noReadGuard: true` disables it.

Swival 1.9.3 passes `--allow <base-dir>` to AgentFS, permitting host write-through on macOS even with a fresh session. Linux AgentFS 0.6.4 overlays its launch cwd instead when that path is also the allowed base. Use a disposable cwd for write exploration. `agentfs diff` shows overlay changes, not a complete record of host-base writes. See [references/agentfs.md](./references/agentfs.md) for session inspection and native snapshot boundaries.

Configure network egress policies with `network` in agent frontmatter or `networkOverride` at dispatch:

| Policy | Behavior |
|--------|----------|
| `full` | Unrestricted network egress (default). |
| `provider-only` | Blocks child commands and Python scripts from the network while preserving provider API access. |
| `none` | Requires nono and the command provider; local HTTP providers still need `provider-only`. |

`nonoRollback: true` or `nonoRollbackOverride: true` passes `--rollback` to nono. Inspect managed snapshots through `nono rollback`; do not assume reviewer rejection restores files.

### A2A (agent-to-agent)

Swival can delegate work to a remote agent over the A2A protocol. Set `a2aConfig` in frontmatter or `a2aConfigOverride` at dispatch time. Point to a TOML file with `[a2a_servers.*]` tables that name reachable endpoints. Relative paths resolve against the task `cwd`. Setting `a2aConfig`, `allowA2a: true`, or `noA2a: false` enables A2A and suppresses `--no-a2a`. A2A requires unrestricted network access; the dispatcher rejects A2A when `network` is set to any policy other than `full` (network defaults to full when omitted). The bundled `a2a-coordinator` agent configures `noA2a: false` and `network: full`. Its system prompt treats remote agent output as untrusted data. Project-scope agents cannot enable A2A. The extension strips `a2aConfig` and forces `noA2a: true`.

### Task prompt delivery

Swival receives the task on standard input when the agent explicitly sets `sandbox: builtin`. Standard input delivery keeps sensitive prompt text out of `ps aux` and clears operating system `ARG_MAX` limits. Only the task text moves to standard input; system prompts, review prompts, and flags remain on argv. Setting `yolo: true` suppresses `sandbox` emission, so yolo runs pass the task on argv. Re-executing sandboxes (`agentfs`, `nono`) and default runs pass the task on argv (`-- <task>`) so the prompt survives `execve`. Project-scope agents in `.pi/swival-agents/` upgrade to `agentfs` automatically and cannot use standard input delivery.

### Secret encryption

Secret encryption replaces detected credentials before model requests and restores values locally. Enable it through `encryptSecrets: true` or `encryptSecretsOverride: true`. Detection does not prove that all secrets are covered. Ordinary delegation provides no host-read confidentiality guarantee. When it is active, SecretShield also rewrites ordinary token-shaped or high-entropy identifiers in the source the model reads, so a reviewer may see format-preserving ciphertext instead of the real text. Treat any token-shaped finding (committed secret, malformed identifier, corrupted constant) from model tool output as unverified: require a `file:line` citation, check that location on the host against the original unencrypted source yourself, and never paste the inspected value into a prompt, report, or follow-up task.

### Agent Client Protocol (ACP)

Run `swival --acp` to speak the Agent Client Protocol on stdio. This allows ACP-aware editors (like Zed or Neovim with `agent-client-protocol.nvim`) to drive Swival natively. Diagnostics are written to `--acp-log` when provided.

### Request auditing

`--llm-filter COMMAND` intercepts every outbound LLM request. Filter receives JSON on stdin, writes filtered messages to stdout. Non-zero exit or `{"allow": false}` blocks the request.

### Command access

| Mode | Effect |
|------|--------|
| `all` (default) | Unrestricted |
| `none` | Disabled |
| `ask` | Per-command approval |
| `ls,git,rg` | Basename allowlist |

Shell wrappers (`bash -c`, pipes, redirects) are blocked in any mode other than `all`.

### Command governance

Inspect, rewrite, or block shell commands before execution using `commandMiddleware` in frontmatter or `commandMiddlewareOverride` at dispatch.

Swival sends command descriptors through standard input. `tool` names the tool; `mode` is `shell` for a command string or `argv` for a string array. A shell invocation receives a payload like this:

```json
{"phase": "before", "tool": "run_shell_command", "cwd": "/path/to/project", "mode": "shell", "command": "rm -rf build", "timeout": 30, "is_subagent": false}
```

The executable returns one JSON object on standard output. These examples allow, rewrite, or deny the command. Every command rewrite requires an explicit valid `mode`:

```json
{"action": "allow"}
{"action": "allow", "mode": "shell", "command": "rm -rf build/temp"}
{"action": "deny", "reason": "Destructive command blocked by policy"}
```

Middleware fails open: malformed responses, invalid rewrite modes or command types, missing executables, timeouts, and nonzero exits permit the original command with a warning. Other command and sandbox policies still apply; middleware failures do not enforce a denial.

Security boundary: `pi-swival` strips `commandMiddleware` from project-local agents in `.pi/swival-agents/`. This protects the host from malicious scripts in untrusted repositories. Inject middleware through user-scoped agents or dispatch overrides.

### Context budgeting

Prevent large tool outputs from exhausting context windows using output caps:

- `maxOutputKb` / `maxOutputKbOverride`: Caps tool output size in kilobytes for file reads, directory scans, grep searches, and web fetches (default: 50 KB).
- `maxOutputLines` / `maxOutputLinesOverride`: Default line cap for file reads (default: 2000 lines).

The dispatcher truncates float inputs in agent frontmatter to positive integers (`Math.trunc`).

Recommended presets:
- Small or budget models (`haiku`, `flash-lite`): `maxOutputKbOverride: 20`, `maxOutputLinesOverride: 250`.
- Deep investigations on frontier models: `maxOutputKbOverride: 100`.

### Telemetry and diagnostics

Swival records execution and security metrics in `report.json`. The `swival-subagent` tool surfaces these values in result headers and `ReportSummary`:

- `promptCache.cachedTokens`: Tokens read from provider cache (`prompt_cache.cached_tokens`).
- `promptCache.cacheWriteTokens`: Tokens written to provider cache on the initial turn (`prompt_cache.cache_write_tokens`).
- `security.commandPolicyBlocks`: Number of commands blocked by middleware or sandbox rules (`security.command_policy_blocks`). Surfaces as a warning in tool results.
- `stormedCalls`: Number of repeated tool calls suppressed by the Swival storm breaker (`stormed_calls`). Indicates model looping.
- `truncationRepairs`: Number of truncated tool outputs or JSON structures recovered automatically (`truncation_repairs`).
- `estimatedCostUsd`: Estimated LLM cost in USD from `stats.estimated_cost_usd` when pricing metadata is available.
- `exposure`: Context budgeting breakdown (`toolResults`, `toolSchemas`, `history`, `summaries`, `totalEstimatedInputTokens`).

### Native subagents

Swival includes native tools for running subagents (`spawn_subagent`, `check_subagents`).

By default, `pi-swival` disables them (`--no-subagents`) to prevent unmonitored recursive execution. Releases before 1.0.44 could auto-enable native subagents despite `--no-subagents` when context was large. The extension enforces a 1.0.44 minimum to prevent this bypass. Swival 1.9.3 serializes concurrent `edit_file` calls per file within a session. Enable native subagents with `subagents: true` in agent frontmatter or `subagentsOverride: true` at dispatch:

```
swival-subagent with agent: "swival", subagentsOverride: true, task: "Survey repository modules in parallel"
```

Use native subagents when Swival must decompose a single prompt into independent child processes autonomously. Use `tasks: [...]` when you want Pi to coordinate separate tasks and collect independent artifacts.

## Model Selection

Agents inherit from `~/.config/swival/config.toml`. Override at dispatch time with `profileOverride` or `modelOverride`.

Named profiles:

```toml
[profiles.budget]
provider = "bedrock"
model = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
reasoning_effort = "low"

[profiles.vertex-research]
provider = "vertexai"
model = "gemini-3.7-flash"
project = "my-gcp-project"
location = "global"
```

Switch at dispatch: `profileOverride: "budget"`.

Native providers include `lmstudio`, `llamacpp`, `huggingface`, `openrouter`, `google` (Gemini API), `vertexai` (alias for `geap`), `chatgpt`, and `bedrock`. `generic` supports OpenAI-compatible endpoints, including local servers. These routes need no intermediary proxy process.

`bedrock` and `vertexai` reject `api_key`. A global `api_key` still applies when a profile selects them; avoid global keys when using these providers. For Bedrock, `base_url` means the region; omit it to inherit the region from `~/.aws/config`. A global value also applies to Vertex profiles, which use `project` and `location` instead. The Vertex project key is `project`, not `gcp_project`.

`noSandboxAutoSession: true` disables deterministic AgentFS session reuse. `sandboxed-explorer` enables it, but it does not isolate host-base writes. Use distinct disposable directories for fan-out.

## Native source-only audit

Use the explicit `audit` API from Pi's configured Git repository root. Read `auditing-with-swival` for scope, routing, and completion rules. It invokes the upstream AgentFS CLI on an independent committed snapshot. Required versions are Swival 1.9.3, LiteLLM 1.106.6, Python >=3.13,<3.15, and AgentFS 0.6.4, with upstream's nono profile installed. The real bootstrap/export gate passed on macOS; Linux and live routes remain unverified.

```json
{"audit":{"all":true}}
```

Consult installation guidance before execution. With no specialist selected, native audit uses configured Swival defaults, including the active profile. When installation policy selects a specialist, pass its existing profile:

```json
{"audit":{"all":true},"profileOverride":"security-specialist"}
```

The name is illustrative, not bundled. A missing or invalid selected specialist stops before launch. A terminal selected-route failure stops without fallback; never retry without the selected specialist. Do not infer specialization from vendor/model names or send source to probe access. Inherit effort unless an override is explicitly authorized.

Swival 1.9.3 can retry the same request on the same provider, model, and endpoint, including recognized policy errors. A later attempt can succeed. The adapter does not guarantee all-phase fail-fast or uniform retry-budget propagation. Never substitute a route or rewrite a refused request. Terminal failures and incomplete audits cannot attest completion.

Native support requires Swival-supported routes meeting the pinned policy contract. Offline representatives cover ChatGPT, API-key OpenRouter, and an explicitly configured compatible loopback endpoint with its own key and context limit. Dynamic model-list adapters are refused because upstream can replace a model after NotFound. Other routes fail for concrete missing capabilities or credential authority, not unfamiliar vendors. Ordinary delegation retains its existing providers and behavior.

For ChatGPT only, standard upstream ChatGPT authentication permits login, token refresh, and auth-state writes. Complete interactive login with upstream Swival outside Pi before an audit. A device-login challenge cancels without returning its contents. AgentFS grants runtime access to a dedicated auth-store directory inside HOME, never through Swival `--add-dir` or model-tool roots. The adapter checks metadata, never auth-store contents. API-key/local routes receive no ChatGPT auth grant. Required encryption/filtering or unsupported policy fails closed; never disable controls or substitute a route.

Native async is unsupported. Timeout, cancellation, and normal session shutdown stop the live owned process group. After a Pi crash or SIGKILL, Swival may remain running. There is no artifact export or claimed completion afterward. Retain crash resources and never signal recovered PIDs or resume native work from disk. A wrapper can register native-only `swival-native-audit` instead of `swival-subagent`. It accepts native fields only, including `encryptSecretsOverride` only as `false`. Encryption, filter, environment, and project-configuration guards remain fail-closed. It rejects dispatch, control, `cwd`, and `async` inputs before preparation. A consumer can run that Pi session as a background child. Only the outer run is asynchronous; the inner native call stays synchronous. See `auditing-with-swival`.

The source-only verifier cannot run project commands, builds, tests, Python, fetch tools, or PoCs. Upstream allows write-through access to the disposable snapshot. Bounded direct collection requires verified shutdown. The original source/Git remain protected; host-read confidentiality and provider-process egress confinement are not guaranteed. Patches are proposals for manual review.

## Interactive REPL

For direct terminal use (outside Pi):

```bash
swival --repl
```

| Command | Effect |
|---------|--------|
| `/init` | Three-pass project scan, writes AGENTS.md |
| `/loop <interval> <prompt>` | Run prompt on a timer (e.g. `5m`, `1h30m`) |
| `/loops` | List active schedules |
| `/unloop <id>` | Cancel active schedule |
| `/audit [paths...]` | Security and quality audit (segment-aware globs) |
| `/audit --all` | Deep-review every in-scope file |
| `/audit --regen --finding N` | Regenerate specific findings |
| `/audit --patch-max-turns N` | Budget for patch generation |
| `/audit --measure-triage` | Recall calibration (triage vs deep-review all) |
| `/goal <objective>` | Goal-driven mode: iterates until done |
| `/learn` | Distil session into persistent memory |
| `/compact` | Compress context |

The REPL is useful for long exploratory sessions. For delegated work from Pi, use `swival-subagent` instead.

## Configuration

| File | Purpose |
|------|----------|
| `~/.config/swival/config.toml` | Global config |
| `swival.toml` (project root) | Project-level overrides |

Generate config: `swival --init-config`. Project config merges over global rather than replacing it, so a project file cannot unset a global `api_key`.

## Troubleshooting

| Error | Cause | Remedy |
|-------|-------|--------|
| `ConfigError` | Unknown provider, missing model, bad API key | `swival --list-profiles`; check auth env vars |
| `ContextOverflowError` | Prompt exceeds context after truncation retries | `--proactive-summaries`; larger-context model |
| `ToolsNotSupportedError` | Model lacks function calling | Switch model; check `--extra-body` |
| `LifecycleError` | Hook failed under `--lifecycle-fail-closed` | Inspect and repair the hook without disabling required controls |

Infrastructure failures: expired AWS SSO, 401/403/429, `ECONNREFUSED` (local model server down), `E2BIG` (giant system prompt).

## Prerequisites

```bash
command -v swival >/dev/null 2>&1 || { echo "swival not found"; exit 1; }
command -v agentfs >/dev/null 2>&1 || { echo "agentfs optional: required for sandbox: agentfs"; }
```

Upgrade to the latest release with `uv tool upgrade swival` (or `pipx upgrade swival`).

### Version preflight

Before spawning, the extension awaits a version preflight:

- Recommended: Swival 1.9.3 or later. Releases between 1.0.44 and 1.9.3 produce an advisory upgrade notice.
- Minimum compatible: Swival 1.0.44 (enforces report schema v1 and subagent recursion bounds). Earlier releases (< 1.0.44) or unverified versions are refused before spawning.
- Results are cached in memory for 60 seconds to avoid per-task probe overhead.

Bedrock and Vertex are reached natively, so there is nothing to start. Bedrock needs a live AWS session; Vertex needs application default credentials. Bundled agents run with `--no-lifecycle`, so refresh credentials before dispatching.

See [setup.md](./references/setup.md) for installation.
