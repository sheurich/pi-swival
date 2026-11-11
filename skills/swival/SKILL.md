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

Tracked against Swival 1.9.3, LiteLLM 1.106.6, and Python >=3.13,<3.15.

Access Swival from Pi through `swival-subagent`. Bundled agent definitions live at `../../agents/<name>.md` relative to this skill.

## Delegation via `swival-subagent`

Add custom `.md` agent definitions in `~/.pi/agent/swival-agents/` (user scope) or `.pi/swival-agents/` (project scope). Discovery priority is `project > user > bundled`. `agentScope` defaults to `"user"`; pass `"project"` or `"both"` to include project definitions (project dispatch requests confirmation unless extension options or `PI_SWIVAL_TRUST_PROJECT_AGENTS=1` disable it).

Unrelated malformed or nameless `.md` files emit bounded diagnostics without blocking valid agents. An identifiable invalid higher-priority definition blocks dispatch only for that exact agent name rather than silently falling back to a lower-priority definition.

### Agent selection

| Agent | Use when |
|-------|----------|
| `self-review-worker` | Implementation, file edits, or artifacts checked by `--self-review`; not for review-only tasks |
| `test-runner` | Task gated by an executable test script passed via `reviewerOverride` |
| `sandboxed-reviewer` | Read-only review (`selfReview: false`, `commands: none`, `noSkills: true`, `network: provider-only`). Suppresses inherited self-review via startup shim (requires explicit `sandbox: agentfs` or `sandbox: builtin` and installed `nono` profile pack for `provider-only`) |
| `sandboxed-explorer` | Exploration in a disposable `cwd` with a fresh AgentFS session; use `sandboxed-reviewer` for read-only reviews |
| `swival` | Simple delegation without review (default when `agent` is omitted) |
| `a2a-coordinator` | Delegate subtasks to remote A2A endpoints configured in an `a2aConfig` TOML file (`network: full`) |

Use [auditing-with-swival](../auditing-with-swival/SKILL.md) for committed-tree native audits and [swival-worker-briefs](../swival-worker-briefs/SKILL.md) when drafting briefs for `self-review-worker`.

### Dispatch examples

Single task (default `swival` agent):

```text
swival-subagent with task: "Summarize the auth module"
```

Self-reviewed implementation:

```text
swival-subagent with agent: "self-review-worker", task: "Add input validation to cmd/serve.go"
```

Test-as-contract:

```text
swival-subagent with agent: "test-runner",
  reviewerOverride: "./run-tests.sh",
  task: "Make the failing tests pass"
```

Sandboxed exploration (always pass a disposable `cwd`; on macOS, AgentFS `--allow <base-dir>` leaves base-directory writes write-through):

```text
swival-subagent with agent: "sandboxed-explorer",
  cwd: "/tmp/disposable-copy",
  task: "Prototype a single-pass parser"
```

Parallel worktree isolation (up to 8 tasks, default concurrency 4; only agents with both `files: none` and `commands: none` may share a `cwd`):

```bash
git worktree add -b worker-a .worktrees/worker-a HEAD
git worktree add -b worker-b .worktrees/worker-b HEAD
```

```text
swival-subagent with tasks: [
  { agent: "self-review-worker", task: "Implement API", cwd: ".worktrees/worker-a" },
  { agent: "self-review-worker", task: "Implement UI", cwd: ".worktrees/worker-b" }
]
```

Fresh worktrees contain committed files only; link or install untracked dependencies before running tests. For bundled and user-scope agents in linked worktrees, `pi-swival` passes `--add-dir-ro <common-git-dir>` so read-only Git commands (`status`, `diff`, `rev-parse`) work under `network: provider-only`.

Sequential chain (`{previous}` expands to the prior step's output):

```text
swival-subagent with chain: [
  { agent: "swival", task: "Summarize the auth module" },
  { agent: "self-review-worker", task: "Given: {previous}\nAdd input validation." }
]
```

### Async / background execution

`async: true` runs a single task in a detached supervisor and returns a `runId` immediately (unsupported in parallel/chain modes, and incompatible with `timeoutMs`, `output`, and `outputMode`):

```text
swival-subagent with agent: "self-review-worker", task: "Refactor the auth module", async: true
```

Manage background runs with `action` and `id`:

| Action | Behavior |
|--------|----------|
| `status` | Report live progress or terminal outcome |
| `resume` | Return completed output and reviewer feedback (does not restart execution) |
| `interrupt` | Stop a run owned by the current Pi process (disk-recovered PIDs are never signaled; uncompleted recovered runs report `unknown`) |

### Paths and output

Relative `cwd` resolves against Pi's `cwd`; relative `output` resolves against the task or step `cwd`. Pi writes `output` atomically (mode `0600`) after symlink checks. Synchronous `output` defaults to `outputMode: "file-only"` (failed chains still inline partial output); pass `outputMode: "inline"` to return both file metadata and text. `maxInlineBytes` caps returned character count. `timeoutMs` applies per child process.

### Dispatch-time overrides

Top-level overrides apply across single, parallel, and chain modes (per-item entries accept `agent`, `task`, `cwd`, `seed`, `output`, and `outputMode`):

| Parameter | Controls |
|-----------|----------|
| `modelOverride` / `profileOverride` / `providerOverride` / `baseUrlOverride` | Model ID, config profile, provider, or base URL |
| `selfReviewOverride` / `reviewerOverride` / `reviewPromptOverride` / `verifyOverride` | Self-review toggle, reviewer script, review rubric, or `--verify` criteria file |
| `maxReviewRoundsOverride` / `maxTurnsOverride` / `maxOutputTokensOverride` | Review round budget, turn cap, or output token limit |
| `temperatureOverride` / `topPOverride` / `seedOverride` / `reasoningEffortOverride` | Sampling controls and reasoning effort |
| `instructionsFullOverride` | Load full `AGENTS.md`/`CLAUDE.md` without truncation |
| `networkOverride` | Network policy (`full`, `provider-only`, `none`) |
| `nonoRollbackOverride` / `nonoBlockNetOverride` | `nono` rollback snapshots or outbound network block |
| `commandMiddlewareOverride` | Pre-command governance executable |
| `maxOutputKbOverride` / `maxOutputLinesOverride` | Tool output KB cap and file-read line cap |
| `addDirOverride` / `addDirRoOverride` | Extra read-write (single mode; `[]` clears) or read-only directories |
| `skillsDirOverride` / `shareSkills` | Extra skill directories or ambient Pi skills |
| `subagentsOverride` | Allow Swival native subagents (`spawn_subagent`) |
| `cacheOverride` / `cacheDirOverride` | Enable LLM response caching and cache path |
| `encryptSecretsOverride` | Request SecretShield encryption |
| `a2aConfigOverride` | A2A TOML config path (single mode; requires `network: full`) |
| `providerTimeoutOverride` / `initialToolChoiceOverride` | Provider request timeout (s) or initial tool choice (`auto`, `required`) |

## Authoring Agent Definitions

Create `~/.pi/agent/swival-agents/<name>.md` with YAML frontmatter:

```yaml
---
name: my-agent
description: What this agent does
selfReview: true
reviewPrompt: "Check X and Y"
maxReviewRounds: 5
requiresReviewer: true
sandbox: agentfs                  # builtin | agentfs | nono
files: some                       # none | some | all
commands: all                     # all | none | ask | "ls,git,rg"
network: provider-only            # full | provider-only | none
noInstructions: true
noMemory: true
noLifecycle: true
noMcp: true
noA2a: true
noHistory: true
noContinue: true
noSubagents: true
encryptSecrets: true
---

System prompt body here (optional).
```

Keep model routing in `~/.config/swival/config.toml` rather than hardcoding `model`, `provider`, or `baseUrl` in agent files.

### Agent configs do not inherit

Every agent file is standalone with no base-agent inheritance. When forking a bundled agent:

- Preserve `requiresReviewer: true` if completion must require a reviewer. Project-scope overrides cannot strip a shadowed user or bundled agent's `requiresReviewer: true`.
- Nested-invocation hygiene flags default to disabling lifecycle, MCP, A2A, web search, history, continuation, memory, and native subagents (`--no-subagents` is enforced unless opted in); `noInstructions` must be set explicitly when desired.
- Project-scope agents (`.pi/swival-agents/`) strip privilege-escalating fields (`yolo`, `extraArgs`, `profile`, `reviewer`, `verify`, `commandMiddleware`, `nonoProfile`, `skillsDir`, `provider`, `model`, `baseUrl`, `baseDir`, `addDir`, `addDirRo`, `a2aConfig`, `allowA2a`), force `sandbox: agentfs`, `noA2a: true`, and `noWebSearch: true`, and narrow `network` to `"none"` only.

## Capabilities Reference

- **Reviewer loop:** `--self-review` (fresh-context LLM review) and `--reviewer` (script exit `0` accept, `1` retry, `2` error) are mutually exclusive; default budget is 15 rounds.
- **Sandboxes & network:** `builtin` (application path checks; enables `stdin` task delivery), `agentfs` (overlay/platform sandbox; see [references/agentfs.md](./references/agentfs.md)), and `nono` (Landlock/Seatbelt kernel isolation, rollback snapshots, and `network: none`). `noSandboxAutoSession: true` disables deterministic AgentFS session reuse.
- **Task prompt delivery:** Tasks pass on `argv` after `--` whenever sandbox re-exec is possible, and over `stdin` only with explicit `sandbox: builtin` (without `yolo: true`).
- **SecretShield host verification:** When `encryptSecrets` is active, SecretShield replaces token-shaped or high-entropy spans before the model reads source. Treat reviewer claims about token appearance as unverified until you inspect the cited `file:line` on the host in unencrypted source, and never paste secret values into prompts or reports.
- **A2A & ACP:** Set `a2aConfig` / `a2aConfigOverride` with `network: full` to delegate to `[a2a_servers.*]` endpoints; run `swival --acp` outside Pi for editor ACP stdio integration.
- **Request & command governance:** `--llm-filter` inspects outbound LLM JSON on stdin. `commandMiddleware` inspects tool commands before execution (fails open on middleware errors; stripped in project scope):

```json
{"phase": "before", "tool": "run_shell_command", "cwd": "/path/to/project", "mode": "shell", "command": "rm -rf build", "timeout": 30, "is_subagent": false}
```

Return one JSON verdict on stdout (`allow`, rewrite with explicit `mode`, or `deny`):

```json
{"action": "deny", "reason": "Destructive command blocked by policy"}
```

- **Telemetry & context caps:** `maxOutputKb` (default 50 KB) and `maxOutputLines` (default 2000) bound tool reads. Run reports surface prompt-cache hits, command-policy blocks, storm-breaker suppressions, truncation repairs, estimated cost, and token exposure.

## Model Selection

Configure profiles in `~/.config/swival/config.toml` and select them with `profileOverride`:

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

`bedrock` and `vertexai` reject `api_key` (avoid setting a top-level global `api_key` when using them). Bedrock uses `base_url` as an optional AWS region; Vertex uses `project` and `location`. See [setup.md](./references/setup.md) for provider configuration and `uv tool upgrade swival`.

## Native source-only audit

Run structured committed-tree audits from the target Git repository root (`{"audit":{"all":true}}` or with an operator-configured profile):

```json
{"audit":{"all":true}}
```

```json
{"audit":{"all":true},"profileOverride":"security-specialist"}
```

See [auditing-with-swival](../auditing-with-swival/SKILL.md) for route admission, AgentFS snapshot isolation, and completion evidence.

## Version Preflight & Troubleshooting

The extension requires Swival `>= 1.0.44` and recommends `1.9.3`. Refresh short-lived cloud credentials (AWS SSO, `gcloud auth application-default login`) before dispatch because bundled agents pass `--no-lifecycle`.

| Error | Remedy |
|-------|--------|
| `ConfigError` | Check `swival --list-profiles` and provider credentials |
| `ContextOverflowError` | Pass `--proactive-summaries`, lower `maxOutputKbOverride`, or select a larger-context profile |
| `ToolsNotSupportedError` | Switch to a tool-capable model |
| `LifecycleError` | Repair the configured hook without disabling required `--lifecycle-fail-closed` checks |
