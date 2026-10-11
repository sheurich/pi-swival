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

Tracked against Swival 1.0.46.

Swival combines reviewer loops, filesystem sandboxing, secret encryption, request filtering, and A2A orchestration. Access it through `swival-subagent`.

## Delegation via swival-subagent

The `swival-subagent` tool dispatches tasks with structured results, finalization trace display, and error classification. Bundled agents ship with the package and work immediately. Override or extend them by placing `.md` files in `~/.pi/agent/swival-agents/` (user scope) or `.pi/swival-agents/` (project scope). Discovery priority: project > user > bundled. By default, `agentScope` defaults to `user`. Project-scope agents require `agentScope: "project"` or `"both"`. Every project-scope dispatch prompts for user confirmation unless disabled with `PI_SWIVAL_TRUST_PROJECT_AGENTS=1` (or `true`) or extension options.

Bundled definitions live at `../../agents/<name>.md` relative to this skill, so the path holds wherever Pi installed the package. Read that file to see an agent's real frontmatter.

### Agent selection

| Agent | Use when |
|-------|----------|
| `self-review-worker` | Implementation, file edits, or artifacts that should pass through `--self-review`; not for review-only tasks |
| `test-runner` | Task has a runnable test command as acceptance criterion (pass `reviewerOverride`) |
| `sandboxed-explorer` | Exploratory changes you want to inspect before applying |
| `swival` | Simple delegation, no review needed (also the default when agent is omitted) |
| `a2a-coordinator` | Delegate part of a task to a remote A2A agent named in an `a2aConfig` TOML file; requires `network: full` |

Use `auditing-with-swival` and the explicit `audit` API for native execution. Ordinary delegation adds one fixed plain-text heading; slash/bang text stays a prompt even with ambient `oneshot_commands=true`. Task metadata remains unchanged. This prevents unintended command-script dispatch, not model prompt injection. Use `swival-worker-briefs` for `self-review-worker` task briefs.

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

Sandboxed exploration:

```
swival-subagent with agent: "sandboxed-explorer",
  task: "Refactor the database layer"
```

Parallel task isolation:

Parallel tasks run across separate processes but share the host filesystem. The `tasks` array supports up to 8 tasks and defaults to a concurrency of 4. The dispatcher groups tasks by target directory and rejects write-capable tasks that target the same `cwd`.

Zero-setup isolation with AgentFS (writes divert to virtual overlays):

```
swival-subagent with tasks: [
  { agent: "sandboxed-explorer", task: "Refactor parser logic" },
  { agent: "sandboxed-explorer", task: "Refactor tokenizer logic" }
]
```

AgentFS fan-out on a shared directory requires `noSandboxAutoSession: true` and no named shared session. `sandboxed-explorer` enables this setting. Command-name allowlists are write-capable, including `git`; without fresh overlays, same-cwd parallel dispatch requires both `files=none` and `commands=none`.

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

Fresh worktrees track committed files only. Untracked dependencies (`node_modules`, `.venv`, `.env`) must be installed or linked before running builds or tests. Worktrees isolate concurrent writes against race conditions, but share `.git` configuration and hooks with the host repository.

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

The tool returns a `runId` (e.g. `swival-run-1716326580000`). `async: true` is only supported in single-agent mode, not chain/parallel. Native `async` requires the originating Pi process to stay connected. Pi disconnect cancels the native audit; ordinary delegation keeps its existing background behavior. After verified shutdown, native finalization preserves bounded partial evidence before cleanup. Preservation failure retains the remaining snapshot for diagnosis. The wrapper writes a `spawn-error.txt` failure fallback if completion-marker persistence fails, even after Pi exits. Without live ownership or valid terminal evidence, disk-only native state is unknown. The extension never signals or probes a PID recovered from disk.

Once started, manage it using `action` and `id`:

| Action      | Description |
|-------------|-------------|
| `status`    | Check if running, or get the final outcome if done |
| `resume`    | Get the final answer and reviewer feedback when finished |
| `interrupt` | Cancel a running task via SIGTERM |

Example:
```
swival-subagent with action: "status", id: "swival-run-1716326580000"
```

### Dispatch-time overrides

Override agent frontmatter per call without editing its definition:

| Parameter | Controls |
|-----------|----------|
| `modelOverride` | Model ID |
| `profileOverride` | Named profile from config.toml |
| `providerOverride` | Provider name |
| `baseUrlOverride` | Provider base URL |
| `selfReviewOverride` | Enable/disable self-review |
| `reviewerOverride` | Path to reviewer script |
| `reviewPromptOverride` | Custom review criteria |
| `maxReviewRoundsOverride` | Review round budget |
| `maxTurnsOverride` | Agent turn limit |
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
| `skillsDirOverride` | Additional directories to scan for skills |
| `shareSkills` | Share ambient Pi skills with Swival |
| `subagentsOverride` | Allow Swival to spawn native subagents |
| `cacheOverride` | Enable LLM response caching |
| `cacheDirOverride` | Cache directory |
| `a2aConfigOverride` | Path to an A2A TOML config file (single mode only); requires `network: full` |
| `providerTimeoutOverride` | Provider request timeout in seconds (default 900) |
| `initialToolChoiceOverride` | Tool selection for the first model request (`auto`, `required`) |

Swival's `/reasoning` command is REPL-only. Use `reasoningEffortOverride` (or the agent frontmatter `reasoningEffort`) as the Pi equivalent.

## Authoring Agent Definitions

Create a `.md` file in `~/.pi/agent/swival-agents/` with YAML
frontmatter:

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
noSandboxAutoSession: false       # sandboxed-explorer sets true for fresh overlays
nonoRollback: true                # nono only: atomic rollback snapshots
network: provider-only            # full | provider-only | none

# Nested-invocation hygiene (defaults: all true)
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

Each agent's frontmatter is independent. There is no base agent, `extends:` field, or implicit inheritance. When you fork a bundled agent, copy its entire frontmatter; omitted flags revert to schema defaults. Preserve these constraints:

- `noSandboxAutoSession: true` on `sandboxed-explorer` is what makes parallel same-directory fan-out work. Drop it in a user-scope fork and the dispatcher refuses parallel execution on a shared `cwd`.
- `requiresReviewer: true` on `test-runner` is what makes the test-as-contract gate enforceable. Drop it in a fork and the agent will report completion without running the test script.
- The nested-invocation hygiene flags (`noLifecycle`, `noMcp`, `noA2a`, `noHistory`, `noContinue`, `noMemory`, `noSubagents`) default to `true` for every agent unless the frontmatter sets them to `false`. The dispatcher enforces `--no-subagents` by default to prevent unbounded subagent recursion. Do not rely on schema defaults, restate the flags you want.
- Project-scope agents cannot preserve the full frontmatter set. For security, `pi-swival` strips execution and sandbox override fields from project-local agents. Stripped fields include `yolo`, `extraArgs`, `profile`, `reviewer`, `verify`, `commandMiddleware`, `nonoProfile`, and `skillsDir`. The sanitizer also strips `provider`, `model`, `baseUrl`, `baseDir`, `addDir`, and `addDirRo`. It removes `a2aConfig` and `allowA2a`, and forces `noA2a: true`. It narrows `network` to `none` only. It forces `sandbox: agentfs`, even if frontmatter requests `sandbox: nono`. Fork agents that need these capabilities into user scope (`~/.pi/agent/swival-agents/`).
- A project-scope agent that shadows a bundled or user-scope agent name cannot unset `requiresReviewer: true` inherited from the shadowed name — the dispatcher forces it back to `true` so a repo-controlled file cannot impersonate `test-runner` (or any other reviewer-gated name) to silently drop its test-as-contract gate.

When overriding a bundled agent name from the user scope, diff your frontmatter against the bundled definition and ensure every semantically-load-bearing flag is preserved:

```bash
# run from this skill's directory
diff ../../agents/sandboxed-explorer.md ~/.pi/agent/swival-agents/sandboxed-explorer.md
```

## Capabilities Reference

### Upstream Swival 1.0.46 behaviors

Swival 1.0.46 includes these released behaviors:

- Image-rejection retries, generic session headers, streamed A2A response limits, and endpoint-scoped model corrections apply automatically.
- Large MCP tool catalogs load schemas on demand via `tool_search`; applies automatically to agents forked with `noMcp: false`.
- Concurrent `edit_file` calls serialize per file within a session, preventing agents and subagents from overwriting edits.
- `swival --init-config` preserves existing configuration values.
- Audit workflows (`/audit`) defend against hostile Git config and handle unusual tracked filenames.

### Reviewer loop

Automated review loop that evaluates task output after each answer and retries until acceptance or budget exhaustion.

- Self-review: same model, fresh context evaluates the output
- Test-as-contract: external script gates completion (exit 0 = accept, 1 = retry with stdout as feedback, 2 = reviewer error)
- `--verify FILE`: feeds acceptance criteria to the reviewer
- Default budget: 15 rounds (`maxReviewRounds` overrides)

Self-review and `--reviewer` are mutually exclusive.

### Filesystem sandbox and network isolation

Swival supports three sandbox backends:

| Mode | Backend | Capabilities |
|------|---------|--------------|
| `builtin` | Application path checks | Fast. Enables standard input prompt delivery. |
| `agentfs` | Virtual SQLite overlay | Safe exploratory writes. Inspect with `agentfs diff <session-id>`. |
| `nono` | OS kernel (Landlock/Seatbelt) | Kernel isolation. Enables rollback snapshots and network blocking. |

The read-before-write guard prevents overwriting unread files. Disable with `noReadGuard: true` for agents that create files from scratch.

AgentFS overlays do not merge back automatically. Inspect with `agentfs diff <session-id>` and apply manually. See [references/agentfs.md](./references/agentfs.md) for session lookup, database locations (`~/.agentfs/run/<id>/delta.db`), and extraction procedures.

Configure network egress policies with `network` in agent frontmatter or `networkOverride` at dispatch:

| Policy | Behavior |
|--------|----------|
| `full` | Unrestricted network egress (default). |
| `provider-only` | Blocks child commands and Python scripts from the network while preserving provider API access. |
| `none` | Complete air-gap isolation. Blocks all outbound traffic. Requires an offline provider. |

Enable atomic filesystem snapshots with `nonoRollback: true` or `nonoRollbackOverride: true`. If a run fails or encounters errors, Swival reverts filesystem changes automatically.

### A2A (agent-to-agent)

Swival can delegate work to a remote agent over the A2A protocol. Set `a2aConfig` in frontmatter or `a2aConfigOverride` at dispatch time. Point to a TOML file with `[a2a_servers.*]` tables that name reachable endpoints. Relative paths resolve against the task `cwd`. Setting `a2aConfig`, `allowA2a: true`, or `noA2a: false` enables A2A and suppresses `--no-a2a`. A2A requires unrestricted network access; the dispatcher rejects A2A when `network` is set to any policy other than `full` (network defaults to full when omitted). The bundled `a2a-coordinator` agent configures `noA2a: false` and `network: full`. Its system prompt treats remote agent output as untrusted data. Project-scope agents cannot enable A2A. The extension strips `a2aConfig` and forces `noA2a: true`.

### Task prompt delivery

Swival receives the task on standard input when the agent explicitly sets `sandbox: builtin`. Standard input delivery keeps sensitive prompt text out of `ps aux` and clears operating system `ARG_MAX` limits. Only the task text moves to standard input; system prompts, review prompts, and flags remain on argv. Setting `yolo: true` suppresses `sandbox` emission, so yolo runs pass the task on argv. Re-executing sandboxes (`agentfs`, `nono`) and default runs pass the task on argv (`-- <task>`) so the prompt survives `execve`. Project-scope agents in `.pi/swival-agents/` upgrade to `agentfs` automatically and cannot use standard input delivery.

### Secret encryption

Credentials in tool output are format-preserving encrypted before
reaching the LLM. The model sees plausible fakes; real values are
restored locally. Enable with `encryptSecrets: true` in the agent
or at dispatch time.

### Agent Client Protocol (ACP)

Run `swival --acp` to speak the Agent Client Protocol on stdio. This allows ACP-aware editors (like Zed or Neovim with `agent-client-protocol.nvim`) to drive Swival natively. Diagnostics are written to `--acp-log` when provided.

### Request auditing

`--llm-filter COMMAND` intercepts every outbound LLM request.
Filter receives JSON on stdin, writes filtered messages to stdout.
Non-zero exit or `{"allow": false}` blocks the request.

### Command access

| Mode | Effect |
|------|--------|
| `all` (default) | Unrestricted |
| `none` | Disabled |
| `ask` | Per-command approval |
| `ls,git,rg` | Basename allowlist |

Shell wrappers (`bash -c`, pipes, redirects) are blocked in any
mode other than `all`.

### Command governance

Inspect, rewrite, or block shell commands before execution using `commandMiddleware` in frontmatter or `commandMiddlewareOverride` at dispatch.

Swival sends command descriptors via standard input to the middleware executable:

```json
{"command": "rm -rf build", "mode": "run_shell_command"}
```

The executable responds on standard output with one of three JSON payloads:

```json
{"action": "allow"}
{"action": "allow", "command": "rm -rf build/temp"}
{"action": "deny", "reason": "Destructive command blocked by policy"}
```

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

By default, `pi-swival` disables them (`--no-subagents`) to prevent unmonitored recursive execution. Swival releases prior to 1.0.44 could auto-enable native subagents when context was large, ignoring `--no-subagents`; `pi-swival` enforces a 1.0.44 minimum compatible version to prevent this bypass. Swival 1.0.45 also serializes concurrent `edit_file` calls per file when subagents run. Enable native subagents with `subagents: true` in agent frontmatter or `subagentsOverride: true` at dispatch:

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

Native providers, no proxy needed: `lmstudio`, `llamacpp`, `huggingface`, `openrouter`, `google` (Gemini API), `vertexai` (alias for `geap`), `chatgpt`, `bedrock`, and `generic` (any OpenAI-compatible endpoint, such as a local server).

Configuration constraints: `bedrock` and `vertexai` both reject `api_key`, and a global `api_key` still applies when a profile selects them, so do not set one globally on a work-cloud host. For `bedrock`, `base_url` means the region; leave it unset to take the region from `~/.aws/config`, since a global value leaks into `vertexai` profiles, which take `project` and `location` instead. The Vertex project key is `project`, not `gcp_project`.

## Interactive REPL

For authorized Daybreak use outside Pi, start the REPL with `swival --provider chatgpt --model gpt-daybreak-blue-latest --reasoning-effort xhigh --repl`. This exact selection requires prior human ChatGPT login and account authorization, but it does not require a named profile. For other approved routes, verify the configured profile with `swival --list-profiles`; use `frontier` with `high` unless the operator selects another route. Preserve provider and data boundaries. A route selection is not permission to use its provider. In the REPL, `/audit <paths-or-globs>` takes paths, not bucket prose. It can generate patches and edit-capable worktrees. Native auxiliary calls omit effort, shielding, and filtering; requested effort is not guaranteed for every phase. Do not fall back after an unavailable or rejected route.

For delegated native Daybreak audit, start Pi at the target Git root and use:

```json
{
  "audit": { "paths": ["src/**/*.py"], "all": true },
  "providerOverride": "chatgpt",
  "modelOverride": "gpt-daybreak-blue-latest",
  "reasoningEffortOverride": "xhigh"
}
```

Direct overrides apply only to that call. They do not change stored configuration, host defaults, or ordinary delegation. For another approved route, use its verified profile and effort overrides.

This mode requires Swival 1.0.46, LiteLLM 1.103.3, Python 3.13+, Linux on Debian ARM64 with util-linux 2.41.5-0+deb13u1, bubblewrap 0.12.0-1~deb13u1, pidfd support, and the reviewed nono 0.79.0 ARM64 GNU artifact identity. It uses the pinned canonical `unshare --user --map-current-user --mount --propagation private --` prefix before bubblewrap. Darwin/macOS native audits are unsupported. Ordinary delegation keeps AgentFS. Unverified prerequisites fail closed. Require a passing real native-layout isolation canary on Linux before use; offline tests do not prove OS isolation. It isolates committed contents and preserves state/reports/patches outside the source checkout. It rejects protected or unsupported routes without fallback. See `auditing-with-swival` for scope limits and verification caveats. Ordinary plain-language delegation remains separate.

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
| `/goal <objective>` | Goal-driven mode — iterates until done |
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
| `LifecycleError` | Hook failed under `--lifecycle-fail-closed` | Inspect hook; drop fail-closed |

Infrastructure failures: expired AWS SSO, 401/403/429,
`ECONNREFUSED` (local model server down), `E2BIG` (giant system
prompt).

## Prerequisites

```bash
command -v swival >/dev/null 2>&1 || { echo "swival not found"; exit 1; }
command -v agentfs >/dev/null 2>&1 || { echo "agentfs optional: required for sandbox: agentfs"; }
```

Upgrade Swival to the latest release:

```bash
uv tool upgrade swival
# or: pipx upgrade swival
```

### Version preflight

Before spawning, the extension runs a fast, non-blocking version preflight:

- Recommended: Swival 1.0.46 or later for ordinary delegation. Earlier compatible releases produce an advisory upgrade notice. Native audit verifies only Swival 1.0.46 and fails closed on other releases.
- Minimum compatible: Swival 1.0.44 (enforces report schema v1 and subagent recursion bounds). Earlier releases (< 1.0.44) or unverified versions are refused before spawning.
- Results are cached in memory for 60 seconds to avoid per-task probe overhead.

Bedrock and Vertex are reached natively, so there is nothing to start. Bedrock needs a live AWS session; Vertex needs application default credentials. Bundled agents run with `--no-lifecycle`, so refresh credentials before dispatching.

See [setup.md](./references/setup.md) for installation.
