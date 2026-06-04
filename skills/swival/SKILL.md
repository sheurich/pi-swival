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

Tracked against Swival 1.0.18.

Swival is a coding agent with a built-in reviewer loop, layered
sandboxing (builtin + AgentFS), format-preserving secret
encryption, outbound request filtering, and A2A orchestration.
Access it from Pi via the `swival-subagent` tool.

## Delegation via swival-subagent

The `swival-subagent` tool dispatches tasks to swival with
streaming, structured results, and error classification. Bundled
agents ship with the package and work immediately. Override or
extend them by placing `.md` files in
`~/.pi/agent/swival-agents/` (user) or `.pi/swival-agents/`
(project). Discovery priority: project > user > bundled.

### Agent selection

| Agent | Use when |
|-------|----------|
| `self-review-worker` | Implementation, file edits, or artifacts that should pass through `--self-review`; not for review-only tasks |
| `test-runner` | Task has a runnable test command as acceptance criterion (pass `reviewerOverride`) |
| `sandboxed-explorer` | Exploratory changes you want to inspect before applying |
| `swival` | Simple delegation, no review needed (also the default when agent is omitted) |

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

Parallel:

```
swival-subagent with tasks: [
  { agent: "self-review-worker", task: "Refactor auth module" },
  { agent: "self-review-worker", task: "Add error handling to parser" }
]
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

The tool returns a `runId` (e.g. `swival-run-1716326580000`). `async: true` is only supported in single-agent mode, not chain/parallel.

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

Override agent frontmatter per call without editing the agent
definition:

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
| `cacheOverride` | Enable LLM response caching |
| `cacheDirOverride` | Cache directory |

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
sandbox: agentfs                  # builtin | agentfs
files: some                       # none | some | all
commands: all                     # all | none | ask | "ls,git,rg"
yolo: true                        # shorthand: files=all, commands=all

# Nested-invocation hygiene (defaults: all true)
noInstructions: true
noMemory: true
noLifecycle: true
noMcp: true
noA2a: true
noHistory: true
noContinue: true

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

Do not specify `model`, `provider`, or `baseUrl` in agent
definitions. Model routing belongs in `~/.config/swival/config.toml`
(managed per environment alongside the rest of your shell config).
Use `profileOverride` at
dispatch time when a specific profile is needed.

### Agent configs do not inherit

Each agent's frontmatter is independent. There is no base agent, no
`extends:` field, and no implicit inheritance from the bundled set.
When you fork a bundled agent into `~/.pi/agent/swival-agents/` or
`.pi/swival-agents/`, copy the entire frontmatter; flags you omit
revert to the schema default, which is rarely what the bundled
agent intended. The trap to watch for:

- `noSandboxAutoSession: true` on `audit-worker` is what makes
  parallel `/audit` fan-out work. Drop it in a fork and the next
  parallel dispatch deadlocks on the AgentFS SQLite overlay.
- `requiresReviewer: true` on `test-runner` is what makes the
  test-as-contract gate enforceable. Drop it in a fork and the
  agent will silently report "completed" without ever running the
  test script.
- The nested-invocation hygiene flags (`noLifecycle`, `noMcp`,
  `noA2a`, `noHistory`, `noContinue`, `noMemory`, `noSubagents`)
  default to `true` only for *bundled* agents whose frontmatter
  declares them. The schema default for an unspecified flag is
  `undefined`, which `buildSwivalArgs` treats as `true` for hygiene
  flags but as `false` for everything else — do not rely on this
  asymmetry, restate the flags you want.

When overriding a bundled agent name from the user or project scope,
diff your frontmatter against the bundled file and ensure every
semantically-load-bearing flag is preserved.

## Capabilities Reference

### Reviewer loop

The headline feature. Runs after each answer; retries until
acceptance or budget exhaustion.

- Self-review: same model, fresh context evaluates the output
- Test-as-contract: external script gates completion (exit 0 =
  accept, 1 = retry with stdout as feedback, 2 = reviewer error)
- `--verify FILE`: feeds acceptance criteria to the reviewer
- Default budget: 15 rounds (`maxReviewRounds` overrides)

Self-review and `--reviewer` are mutually exclusive.

### Filesystem sandbox

| Mode | Effect |
|------|--------|
| Default (`files: some`) | Reads/writes confined to base directory |
| `files: all` | Unrestricted |
| `files: none` | Only `.swival/` accessible |
| `sandbox: agentfs` | OS-enforced overlay; writes hit SQLite, not real FS |

The read-before-write guard prevents overwriting unread files.
Disable with `noReadGuard: true` for agents that create files
from scratch.

AgentFS overlay does not merge back automatically. Inspect with
`agentfs diff <session-id>` and apply manually.

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

## Model Selection

Agents inherit from `~/.config/swival/config.toml`. Override at
dispatch time with `profileOverride` or `modelOverride`.

Named profiles:

```toml
[profiles.fast]
provider = "generic"
model = "claude-haiku-4-5"
base_url = "http://127.0.0.1:4000"

[profiles.local]
provider = "lmstudio"
model = "qwen3-30b"
```

Switch at dispatch: `profileOverride: "fast"`.

Native providers (no proxy needed): `lmstudio`, `llamacpp`,
`huggingface`, `openrouter`, `google` (Gemini API), `chatgpt`,
`bedrock`, `generic` (any OpenAI-compatible endpoint).

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
| `/goal <objective>` | Goal-driven mode — iterates until done |
| `/learn` | Distil session into persistent memory |
| `/compact` | Compress context |

The REPL is useful for long exploratory sessions. For delegated
work from Pi, use `swival-subagent` instead.

## Configuration

| File | Purpose |
|------|----------|
| `~/.config/swival/config.toml` | Global config |
| `~/.config/litellm/config.yaml` | Proxy model routing |
| `swival.toml` (project root) | Project-level overrides |

Generate config: `swival --init-config`.
Proxy manager: `swival-proxy start|stop|status|restart`.

## Troubleshooting

| Error | Cause | Remedy |
|-------|-------|--------|
| `ConfigError` | Unknown provider, missing model, bad API key | `swival --list-profiles`; check auth env vars |
| `ContextOverflowError` | Prompt exceeds context after truncation retries | `--proactive-summaries`; larger-context model |
| `ToolsNotSupportedError` | Model lacks function calling | Switch model; check `--extra-body` |
| `LifecycleError` | Hook failed under `--lifecycle-fail-closed` | Inspect hook; drop fail-closed |

Infrastructure failures: expired AWS SSO, 401/403/429,
`ECONNREFUSED` (proxy down), `E2BIG` (giant system prompt).

## Prerequisites

```bash
command -v swival >/dev/null 2>&1 || { echo "swival not found"; exit 1; }
```

If routing through litellm (Vertex / cross-region Bedrock):

```bash
command -v swival-proxy >/dev/null 2>&1 || { echo "proxy not found"; exit 1; }
swival-proxy status || swival-proxy start
```

See [setup.md](./references/setup.md) for installation.
