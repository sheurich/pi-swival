# pi-swival

A Pi package that integrates [Swival](https://github.com/Swival/swival) — a coding agent with a built-in reviewer loop, OS-enforced sandboxing, format-preserving secret encryption, and outbound request filtering — into Pi as a delegation target.

![pi-swival demo](demo/demo-quick.gif)

The package bundles:

- `swival-subagent` extension — dispatches tasks to a swival subprocess with reviewer loops, sandboxes, and structured reporting. Mirrors the shape of pi's example subagent extension but swaps the spawn target to swival.
- `swival` skill — drives swival from any Pi agent via the extension, with reference material on AgentFS sandboxing and native provider setup.
- `auditing-with-swival` skill — one native audit on an isolated committed snapshot, with preserved state, reports, and patch proposals.
- `swival-worker-briefs` skill — task brief structure and evidence standards for `self-review-worker` dispatches.
- `swival-audit` prompt template — slash-command-style invocation that walks an interactive operator through the audit pipeline.
- Five swival agents — `swival`, `self-review-worker`, `test-runner`, `sandboxed-explorer`, and `a2a-coordinator`.

## Install

```bash
pi install https://github.com/sheurich/pi-swival
```

Or pin a tag:

```bash
pi install git:github.com/sheurich/pi-swival@v1.0.0
```

Or install from a local checkout:

```bash
pi install /path/to/pi-swival
```

The package registers `extensions/`, `skills/`, and `prompts/` automatically per its `package.json` `pi` manifest. The five bundled swival agents under `agents/` are discovered automatically by the extension at runtime — no symlinks or manual copies needed.

To override a bundled agent or add your own, place `.md` files in `~/.pi/agent/swival-agents/` (user scope) or `.pi/swival-agents/` in a project root (project scope). Discovery priority: project > user > bundled.

## Prerequisites

This package shells out to the `swival` CLI. Install it first:

```bash
uv tool install swival
# or: pipx install swival
```

Swival routes models through `~/.config/swival/config.toml`. Its `bedrock` and `vertexai` providers reach AWS and Google Cloud natively, with no extra process to run. See `skills/swival/references/setup.md` for the full setup walkthrough.

## What's bundled

### Extension: `swival-subagent`

A Pi tool that dispatches single, parallel, or chained tasks, or one structured native audit. Ordinary delegation retains its existing report handling; native audit requires separate state and coverage evidence.

Key features beyond pi's example subagent extension:

- Reviewer loop (`selfReview` or test-as-contract `reviewer`) that retries until the reviewer accepts.
- Kernel & overlay sandboxing (`sandbox: agentfs` SQLite overlay; `sandbox: nono` Landlock/Seatbelt isolation).
- Network policy (`network: provider-only`, `network: none`).
- Format-preserving secret encryption (`encryptSecrets`).
- LLM request auditing (`extraArgs: ["--llm-filter", "..."]`).
- Standard input task delivery (protects prompts from `ps aux` and bypasses `ARG_MAX` when `sandbox: builtin` is configured).
- Operational telemetry (prompt cache token savings, security policy blocks, and storm breaker suppressions).
- Async / background runs with cross-session `status` / `resume` / `interrupt`.

See `skills/swival/SKILL.md` for dispatch examples and `extensions/index.ts` for the full schema.

### Skills

| Skill | Use |
|-------|-----|
| `swival` | Drive swival from any Pi agent — dispatch examples, agent authoring, capabilities reference, troubleshooting. |
| `auditing-with-swival` | Run native audit on committed source with isolated artifacts and explicit coverage checks. |
| `swival-worker-briefs` | Draft precise, verifiable task briefs for `self-review-worker` dispatches. |

### Prompts

| Prompt | Use |
|--------|-----|
| `swival-audit` | `/swival-audit [relative paths or globs]`: confirm routing and audit Pi's configured repository root. |

### Agents

Bundled in `agents/` for the `swival-subagent` tool:

| Agent | Use when |
|-------|----------|
| `swival` | Generic delegate — no system prompt, no review. The implicit default when `agent` is omitted. |
| `self-review-worker` | Implementation, file edits, or artifacts that should pass through `--self-review`; not for review-only tasks. |
| `test-runner` | Task has a runnable test command as acceptance criterion (caller passes `reviewerOverride`). |
| `sandboxed-explorer` | Exploratory changes you want to inspect before applying. |
| `a2a-coordinator` | Coordinate tasks across remote Agent2Agent (A2A) endpoints configured via a2aConfig; requires network: full. |

### Native audit

Start Pi at the target Git root and use the structured `audit` API:

```json
{"audit":{"all":true}}
```

Consult installation guidance before execution. When it selects a specialist, use its existing configured profile:

```json
{"audit":{"all":true},"profileOverride":"security-specialist"}
```

The profile name is illustrative, not bundled or reserved. With no specialist selected, native audit uses configured Swival provider/model defaults, including `active_profile`. A missing or invalid selected specialist stops before launch. A terminal selected-route failure stops without fallback; never retry without the selected specialist. Do not detect specialization by vendor/model names or probe access with repository content. Inherit effort unless the operator authorizes an override.

Swival 1.0.46 can retry the same request on the same provider, model, and endpoint, including recognized policy errors. A later attempt can succeed. The adapter does not guarantee all-phase fail-fast or uniform retry-budget propagation. Never substitute a route or rewrite a refused request. Terminal failures and incomplete audits cannot attest completion.

Native audit requires Swival 1.0.46, LiteLLM 1.103.4, Python 3.13+, AgentFS 0.6.4, and upstream's installed nono profile. Support means Swival-supported routes meeting required native policies on this runtime. Offline representatives cover ChatGPT, API-key OpenRouter, and a deliberately configured OpenRouter-compatible loopback endpoint with a dedicated key and context limit. Dynamic model-list adapters fail before launch because upstream can replace the selected model after NotFound. Other routes receive concrete capability diagnostics; this is not universal provider/version support. No model, provider, endpoint, profile, or sandbox fallback exists. Linux and live routes remain unverified.

For ChatGPT only, standard upstream ChatGPT authentication permits login, token refresh, and auth-state writes. Complete interactive login with upstream Swival outside Pi before an audit. Device-login challenges cancel without exposing their contents. Refresh and persistence use upstream auth unchanged. The adapter checks auth-store metadata, never its contents. API-key/local routes forward only the selected credential interface and receive no ChatGPT directory grant. Required encryption, filtering, strict-read isolation, proxies, unknown policy, and incompatible routing fail closed. These native restrictions do not change ordinary delegation.

The adapter imports only committed content into a separate disposable repository outside original source and Git metadata. It excludes staged, unstaged, and untracked content. Source hooks, filters, instructions, project runtime settings, skills, MCP, A2A, autonomous subagents, history, memory, and lifecycle hooks do not execute. The upstream CLI uses `commands=none`, `files=some`, and `network=provider-only`. Verification is source-only judgment; project commands, builds, tests, Python, fetch tools, and PoCs cannot run.

The adapter launches upstream AgentFS directly. Its explicit write grants cover the snapshot and, for ChatGPT only, a dedicated auth-store directory inside HOME. The default store is `~/.config/litellm/chatgpt/auth.json`; safe `CHATGPT_TOKEN_DIR` and `CHATGPT_AUTH_FILE` selections are supported. The auth directory never enters Swival `--add-dir` or model-tool roots. Swival runs inside AgentFS with its builtin tool policy, not a second sandbox bootstrap. The adapter collects bounded reports, patches, and state from the writable snapshot after verified shutdown. Upstream also grants temporary, service, and session paths. On macOS, source and Git metadata must not overlap those built-in exceptions, including `/tmp`, `/var/tmp`, `/private/var/folders`, and HOME's `Library`. Aliased locations fail closed before launch. See the [AgentFS reference](skills/swival/references/agentfs.md) for the complete restriction. The adapter claims neither COW-only export, host-read confidentiality, nor provider-process egress confinement. Patches never apply automatically.

Native async is unsupported. Timeout, cancellation, and normal session shutdown stop the live owned group. After a Pi crash or SIGKILL, Swival may remain running. There is no artifact export or claimed completion afterward. Native work never resumes from disk or signals recovered PIDs. Crash resources and AgentFS session metadata remain retained; native artifacts are not automatically pruned.

Completion requires matching committed scope, route/policy, native `phase=done`, mandatory/deep coverage, terminal verification, finding lineage, unique report/patch pairs, and complete diagnostics without lost expansion warnings. Exit zero or an ordinary answer is insufficient. Limits are 4096 entries, 8 MiB per file, and 64 MiB total. See [`auditing-with-swival`](skills/auditing-with-swival/SKILL.md) for options, artifacts, and migration. The retired custom audit orchestration has no aliases. Generic reviews remain separate from native completion evidence.

## Layout

```text
pi-swival/
├── package.json                # Pi package manifest (pi.extensions, pi.skills, pi.prompts)
├── README.md
├── LICENSE
├── extensions/
│   ├── index.ts                # swival-subagent tool implementation
│   ├── agents.ts               # agent discovery from ~/.pi/agent/swival-agents/
│   └── native-audit.ts         # CLI preparation, committed snapshot, native evidence
├── agents/                     # five bundled swival agents (auto-discovered)
├── skills/
│   ├── swival/                 # SKILL.md, references/{agentfs,setup}.md
│   ├── auditing-with-swival/    # native audit workflow
│   └── swival-worker-briefs/   # SKILL.md
├── prompts/
│   └── swival-audit.md         # slash-command-style audit walkthrough
├── scripts/                    # ordinary runner, native preflight/finalizer, smoke helpers
└── tests/                      # offline unit, dispatch, and native entry-point tests
```

## Running the tests

The harness covers parsing, dispatch, report acceptance, traces, snapshots, artifacts, cancellation, and documentation. Native tests execute released finding, verification, patch, and report phases with stubbed LLM responses and denied sockets and DNS. Lifecycle tests use local transport stubs. No live provider calls are part of the suite.

```bash
./tests/setup.sh      # first time only; run directly, not through npm
npm test
```

The offline harness uses Node 22.19+ or Node 24, selected Pi peers, uv, and installed Python 3.13. Setup links peers and syncs the hash-locked Swival 1.0.46/LiteLLM 1.103.4 fixture into ignored `tests/.venv`. Run setup directly, outside npm's lifecycle. Tests and typechecking never install dependencies. The peer-loader, locks, and typecheck setup are shared test prerequisites; ordinary runtime maintenance changes are not included.

From the package root:

```bash
npm test           # runs the already-installed local Vitest binary
npm run typecheck  # checks extension types against the selected Pi peers
npm run smoke      # offline Pi resource-loader check; no model or credentials
npm run native-agentfs-integration  # explicit real native bootstrap/export gate
npm run ci         # typecheck + smoke + ordinary agentfs canary + vitest
```

The smoke test creates an isolated working directory and agent directory, uses in-memory settings, and loads only this package through `DefaultResourceLoader`. It checks the extension and `swival-subagent` tool, bundled skills and prompt, and agent frontmatter without starting a session or reading stdin.

The unit suite uses synthetic CLI processes, released native phases, denied sockets/DNS, and mocked auth HTTP. It covers standard login/refresh/auth writes, inherited same-route policy-error retries, terminal errors, no fallback, tool denials, timeout/cancellation, descendants, and parent loss. The explicit native AgentFS integration command requires installed binaries and never skips a missing prerequisite. Its synthetic nono registration proves availability, not authenticity. API/local fixtures combine the real released zero-finding producer, resolver, AgentFS and finalizer with HTTP doubles. ChatGPT fixtures test standard refresh persistence and model-tool auth denial with synthetic evidence. These runs do not prove live account access or inference. Other platforms and live providers remain unverified.

The golden fixtures under `tests/fixtures/` are the source of truth for the swival report schema this package depends on. Schema drift breaks the snapshots, not live runs.

## End-to-end demo

Two recordings under [`demo/`](demo/):

- `demo-quick.gif` (~70s) shows a failing pytest run, a delegated repair via `self-review-worker`, reviewer acceptance, and the same tests passing. This is the headline demo embedded above.
- `demo-reviewer.gif` (~75s) shows `self-review-worker` creating and testing two Python files before Swival's reviewer accepts the result.

Regenerate with `make -C demo`. The recording harness uses a disposable checkout and home, disables ambient Pi resources, and refuses to run unless the installed Pi matches npm's latest release. See [`demo/README.md`](demo/README.md) for requirements and environment variables.

For a longer step-by-step tour covering AgentFS sandboxing and the `/swival-audit` prompt template, see [`examples/demo.md`](examples/demo.md).

## Tradeoffs vs pi's example subagent extension

Pi does not ship a subagent tool by default. The closest reference points are the [example subagent extension](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) under `examples/extensions/subagent/` in the pi-coding-agent repo, and third-party packages such as [`pi-subagents`](https://github.com/nicobailon/pi-subagents). The table below compares against the example extension; the third-party packages are similar in shape.

| Feature                   | example `subagent`    | `swival-subagent`     |
|---------------------------|-----------------------|-----------------------|
| Live tool streaming       | yes (`--mode json`)   | no; normal traces arrive at finalization |
| Reviewer loop             | no                    | yes                   |
| Test-as-contract          | no                    | yes                   |
| Sandboxing                | no                    | yes (AgentFS + nono)  |
| Network isolation         | no                    | yes (provider-only, none) |
| Secret encryption         | no                    | yes                   |
| Parallel execution        | yes                   | yes                   |
| Chain mode (`{previous}`) | yes                   | yes                   |
| Async / background runs   | no                    | yes (single-mode only) |

Use the example subagent (or a third-party equivalent) when fine-grained tool-call visibility matters more than correctness checks. Use `swival-subagent` when correctness or sandboxing matters more than display fidelity. The two coexist — install both and pick per task.

## Known limitations

- Swival's normal one-shot traces arrive at finalization, not as live tool events. The ordinary watcher retains its existing behavior.
- Swival receives the task on command-line arguments unless the agent explicitly sets `sandbox: builtin`, which pipes it over standard input (keeping it out of `ps aux` and clear of `ARG_MAX`). Project-scope agents cannot use standard input delivery because they are upgraded to `agentfs`. The default is conservative because ambient configuration (`~/.config/swival/config.toml`, `swival.toml`) can enable a re-executing sandbox (AgentFS or nono).
- The agent system prompt body is always passed as `--system-prompt` command-line arguments. Large bodies can hit platform `ARG_MAX` even under `sandbox: builtin`; split long guidance into a skills directory passed via `skillsDir` (or `skillsDirOverride` at dispatch) instead.
- Parallel tasks share the host working tree (no git worktree isolation). Tasks that mutate overlapping files must be dispatched serially or run with per-task `cwd` pointing at pre-created worktrees.
- `async: true` is single-mode only. Parallel and chain modes always run synchronously.
- Ordinary artifact directories under `~/.pi/agent/swival-artifacts/` are eligible for pruning after 7 days. Native directories remain retained. Back up reports you need longer.
- Swival's interactive `/goal` REPL command is not available here — the extension always invokes swival non-interactively.

## License

[MIT](LICENSE)
