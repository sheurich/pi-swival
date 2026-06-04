# pi-swival

A Pi package that integrates [Swival](https://github.com/Swival/swival) — a coding agent with a built-in reviewer loop, OS-enforced sandboxing, format-preserving secret encryption, and outbound request filtering — into Pi as a delegation target.

![pi-swival demo](demo/demo-quick.gif)

The package bundles:

- `swival-subagent` extension — dispatches tasks to a swival subprocess with reviewer loops, sandboxes, and structured reporting. Mirrors the shape of pi's example subagent extension but swaps the spawn target to swival.
- `swival` skill — drives swival from any Pi agent via the extension, with reference material on AgentFS sandboxing and proxy setup.
- `auditing-with-swival` skill — a three-stage recon → per-bucket → consolidate pipeline for security audits over codebases too large for one worker.
- `swival-audit` prompt template — slash-command-style invocation that walks an interactive operator through the audit pipeline.
- Seven swival agents — `swival`, `self-review-worker`, `test-runner`, `sandboxed-explorer` (general-purpose), plus `audit-worker`, `security-recon`, `security-consolidator` (audit pipeline).

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

The package registers `extensions/`, `skills/`, and `prompts/` automatically per its `package.json` `pi` manifest. The seven bundled swival agents under `agents/` are discovered automatically by the extension at runtime — no symlinks or manual copies needed.

To override a bundled agent or add your own, place `.md` files in `~/.pi/agent/swival-agents/` (user scope) or `.pi/swival-agents/` in a project root (project scope). Discovery priority: project > user > bundled.

## Prerequisites

This package shells out to the `swival` CLI. Install it first:

```bash
uv tool install swival
# or: pipx install swival
```

See `skills/swival/references/setup.md` for the full setup walkthrough including the optional litellm proxy for Vertex AI and Bedrock cross-region inference.

## What's bundled

### Extension: `swival-subagent`

A Pi tool that dispatches single, parallel, or chained tasks to swival processes. Surfaces swival's structured `--report` JSON as the authoritative source of final output, status, and review-loop stats.

Key features beyond pi's example subagent extension:

- Reviewer loop (`selfReview` or test-as-contract `reviewer`) that retries until the reviewer accepts.
- AgentFS sandbox (`sandbox: agentfs`) that captures writes in a per-session SQLite overlay.
- Format-preserving secret encryption (`encryptSecrets`).
- LLM request auditing (`extraArgs: ["--llm-filter", "..."]`).
- Async / background runs with cross-session `status` / `resume` / `interrupt`.

See `skills/swival/SKILL.md` for dispatch examples and `extensions/index.ts` for the full schema.

### Skills

| Skill | Use |
|-------|-----|
| `swival` | Drive swival from any Pi agent — dispatch examples, agent authoring, capabilities reference, troubleshooting. |
| `auditing-with-swival` | Run a reproducible multi-bucket security audit over a codebase. Three stages with structured output contracts. |

### Prompts

| Prompt | Use |
|--------|-----|
| `swival-audit` | Slash-command-style invocation: `/swival-audit <repo-ref> [scope notes]`. Walks the operator through the audit pipeline. |

### Agents

Bundled in `agents/` for the `swival-subagent` tool:

| Agent | Use when |
|-------|----------|
| `swival` | Generic delegate — no system prompt, no review. The implicit default when `agent` is omitted. |
| `self-review-worker` | Implementation, file edits, or artifacts that should pass through `--self-review`; not for review-only tasks. |
| `test-runner` | Task has a runnable test command as acceptance criterion (caller passes `reviewerOverride`). |
| `sandboxed-explorer` | Exploratory changes you want to inspect before applying. |
| `audit-worker` | Read-only security or domain audit (Stage 2 of the audit pipeline). |
| `security-recon` | Survey a repository and emit `recon.json` (Stage 1 of the audit pipeline). |
| `security-consolidator` | Merge per-bucket audit reports into one consolidated findings document (Stage 3). |

The first four were extracted from the original `swival-subagent` Pi extension. The last three implement the audit pipeline documented in the `auditing-with-swival` skill.

Audit agents include built-in self-review with JSON / structure contract enforcement, an AgentFS sandbox, and a read-only command allowlist.

## Layout

```text
pi-swival/
├── package.json                # Pi package manifest (pi.extensions, pi.skills, pi.prompts)
├── README.md
├── LICENSE
├── extensions/
│   ├── index.ts                # swival-subagent tool implementation
│   └── agents.ts               # agent discovery from ~/.pi/agent/swival-agents/
├── agents/                     # seven bundled swival agents (auto-discovered)
├── skills/
│   ├── swival/                 # SKILL.md, references/{agentfs,setup}.md, scripts/swival-proxy
│   └── auditing-with-swival/   # SKILL.md, references/{recon-contract,audit-prompt-template,consolidation-contract}.md
├── prompts/
│   └── swival-audit.md         # slash-command-style audit walkthrough
└── tests/                  # vitest harness for pure functions in extensions/
```

## Running the tests

The vitest harness covers the pure functions in `extensions/index.ts` — argument building, report summarization, parallel summary formatting, artifact persistence, trace tailing, UTF-8 boundary handling, and bundled-agent integrity. The harness never spawns an actual `swival` process; everything under test is pure.

```bash
cd tests
./setup.sh           # first time only — installs vitest + symlinks pi peer deps
npx vitest run
```

From the package root:

```bash
npm test       # vitest only
npm run smoke  # manifest + frontmatter + pi-load checks
npm run ci     # smoke + vitest (mirrors CI)
```

The smoke test runs in under a second and validates: every path declared in `package.json#pi` resolves, every bundled agent has sane frontmatter, and `pi -e` loads the package without printing extension errors. It does not need an LLM provider — useful for clean CI runners.

GitHub Actions runs both layers on every push and pull request, against Node 20 and 22.

The golden fixtures under `tests/fixtures/` are the source of truth for the swival report schema this package depends on. Schema drift breaks the snapshots, not live runs.

## End-to-end demo

Two recordings under [`demo/`](demo/):

- `demo-quick.gif` (~60s) — the headline shareable embedded above. Pi dispatches a small task through `swival-subagent`, the structured tool block renders inline, file is verified.
- `demo-reviewer.gif` (~150s) — the reviewer-loop differentiator. Pi loads the `swival` skill, dispatches `self-review-worker`, swival's reviewer iterates until the contract is satisfied, then `report.json` is inspected.

Regenerate with `make -C demo` (requires [`vhs`](https://github.com/charmbracelet/vhs), `pi`, `swival`, and an LLM provider configured for swival).

For a longer step-by-step tour covering AgentFS sandboxing and the `/swival-audit` prompt template, see [`examples/demo.md`](examples/demo.md).

## Tradeoffs vs pi's example subagent extension

Pi does not ship a subagent tool by default. The closest reference points are the [example subagent extension](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) under `examples/extensions/subagent/` in the pi-coding-agent repo, and third-party packages such as [`pi-subagents`](https://github.com/nicobailon/pi-subagents). The table below compares against the example extension; the third-party packages are similar in shape.

| Feature                   | example `subagent`    | `swival-subagent`     |
|---------------------------|-----------------------|-----------------------|
| Per-tool-call streaming   | yes (`--mode json`)   | post-run trace replay |
| Reviewer loop             | no                    | yes                   |
| Test-as-contract          | no                    | yes                   |
| AgentFS sandbox           | no                    | yes                   |
| Secret encryption         | no                    | yes                   |
| Parallel execution        | yes                   | yes                   |
| Chain mode (`{previous}`) | yes                   | yes                   |
| Async / background runs   | no                    | yes (single-mode only) |

Use the example subagent (or a third-party equivalent) when fine-grained tool-call visibility matters more than correctness checks. Use `swival-subagent` when correctness or sandboxing matters more than display fidelity. The two coexist — install both and pick per task.

## Known limitations

- Per-tool-call streaming comes from tailing swival's `--trace-dir` JSONL output and may lag on filesystems with weak `fs.watch` semantics.
- The system prompt body is passed as `--system-prompt` argv. Hundreds-of-KB bodies can hit platform `ARG_MAX`; split long guidance into a skills directory passed via `extraArgs` instead.
- Parallel tasks share the host working tree (no git worktree isolation). Tasks that mutate overlapping files must be dispatched serially or run with per-task `cwd` pointing at pre-created worktrees.
- `async: true` is single-mode only. Parallel and chain modes always run synchronously.
- Artifact directories under `~/.pi/agent/swival-artifacts/` are auto-pruned at 7 days. Back up reports you need longer.
- Swival's interactive `/goal` REPL command is not available here — the extension always invokes swival non-interactively.

## License

[MIT](LICENSE)
