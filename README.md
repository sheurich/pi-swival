# pi-swival

Pi extension wrapping [Swival](https://github.com/Swival/swival) for delegated subagents, reviewer loops, configurable sandboxes, and isolated native security audits.

![pi-swival demo](demo/demo-quick.gif)

## Install

```bash
pi install https://github.com/sheurich/pi-swival
# or pin a tag: pi install git:github.com/sheurich/pi-swival@v1.0.0
```

For a local checkout, install the runtime YAML parser before loading:

```bash
npm install --ignore-scripts --legacy-peer-deps
pi install /path/to/pi-swival
```

Pi loads `extensions/`, `skills/`, and `prompts/` from `package.json`. Bundled agents in `agents/` are discovered automatically with `project > user > bundled` precedence (`.pi/swival-agents/` > `~/.pi/agent/swival-agents/` > `agents/`).

## Prerequisites

Install the `swival` CLI (tested against Swival 1.9.3, LiteLLM 1.106.6, and Python 3.13):

```bash
uv tool install swival
```

Configure model routing in `~/.config/swival/config.toml`. Swival reaches Bedrock, Vertex AI, Anthropic, OpenRouter, ChatGPT, and local OpenAI-compatible servers directly without an external proxy. See [skills/swival/references/setup.md](skills/swival/references/setup.md) for provider setup.

## Usage

`swival-subagent` dispatches delegated work and manages background runs:

- **Single task:** `{ "agent": "self-review-worker", "task": "Add input validation to cmd/serve.go" }` (`agent` defaults to `"swival"` when omitted).
- **Parallel tasks:** `{ "tasks": [{ "agent": "self-review-worker", "cwd": ".worktrees/a", "task": "..." }, ...] }` (up to 8 tasks; writable agents require distinct `cwd` directories).
- **Sequential chain:** `{ "chain": [{ "agent": "swival", "task": "..." }, { "agent": "self-review-worker", "task": "Given: {previous}\n..." }] }`.
- **Async background runs:** pass `"async": true` on a single task, then query or stop with `"action": "status" | "resume" | "interrupt"` and `"id"`.
- **Agent catalogue:** `{ "action": "list", "agentScope": "both" }` inspects discovered agents without spawning Swival.
- **Native source-only audit:** `{ "audit": { "all": true } }` runs Swival `/audit` inside AgentFS on an isolated snapshot of `HEAD` (see [skills/auditing-with-swival/SKILL.md](skills/auditing-with-swival/SKILL.md)).

See [skills/swival/SKILL.md](skills/swival/SKILL.md) for override parameters, custom agent frontmatter, and worktree patterns, or [examples/demo.md](examples/demo.md) for an end-to-end walkthrough.

### Optional async observation

Async runs record their owning session UUID. By default, `pi-swival` performs no background observation polling; explicit `status`, `resume`, and same-process `interrupt` controls work standalone.

To project owned runs into `pi-subagents` Fleet and `bg_wait`, create a local wrapper linking your installed `pi-swival` and `pi-subagents` package directories (check `pi list` for exact paths):

```bash
mkdir -p ~/.pi/agent/swival-observation/node_modules
ln -s /opt/pi-packages/pi-swival ~/.pi/agent/swival-observation/node_modules/pi-swival
ln -s /opt/pi-packages/pi-subagents ~/.pi/agent/swival-observation/node_modules/pi-subagents
```

Save `~/.pi/agent/swival-observation/index.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSwival from "pi-swival/extensions/index.ts";
import { createPiSubagentsAdapter } from "pi-swival/integrations/pi-subagents.ts";
import {
  registerExternalRun, updateExternalRun, unregisterExternalRun,
} from "pi-subagents/external-runs";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";

export default function (pi: ExtensionAPI) {
  registerSwival(pi, {
    observationAdapter: createPiSubagentsAdapter({
      registerExternalRun, updateExternalRun, unregisterExternalRun,
      registerBackgroundWorkProvider,
    }),
  });
}
```

Disable the default `pi-swival` extension entry in `~/.pi/agent/settings.json` so only the wrapper registers `swival-subagent`, then restart Pi or run `/reload`:

```json
{
  "packages": [
    {
      "source": "https://github.com/sheurich/pi-swival",
      "extensions": []
    },
    "npm:pi-subagents"
  ],
  "extensions": ["./swival-observation/index.ts"]
}
```

The adapter is strictly observation-only: it exposes bounded run status without task text, output, PIDs, or stop authority, and omits `unknown` disk-recovered runs from active waits.

### Skills

| Skill | Purpose |
|-------|---------|
| `swival` | Dispatch patterns, override parameters, custom agent authoring, sandboxes, and provider setup. |
| `auditing-with-swival` | Committed-snapshot native `/audit` workflow, route admission, AgentFS boundary, and artifact checks. |
| `swival-worker-briefs` | Structured task briefs and parent verification checklist for `self-review-worker`. |

### Prompts

| Prompt | Purpose |
|--------|---------|
| `swival-audit` | `/swival-audit [paths...]`: confirm scope/profile and run a native committed-tree audit. |

### Agents

| Agent | Use when |
|-------|----------|
| `swival` | Generic delegation without review (default when `agent` is omitted). |
| `self-review-worker` | Code edits or generated artifacts checked by `--self-review` before returning. |
| `test-runner` | Implementation gated by an executable test script via `reviewerOverride`. |
| `sandboxed-reviewer` | Read-only review (`selfReview: false`, `commands: none`, `network: provider-only`). |
| `sandboxed-explorer` | Exploration in a disposable `cwd` with a fresh AgentFS session. |
| `a2a-coordinator` | Delegation across remote Agent2Agent endpoints configured via `a2aConfig` (`network: full`). |

#### Native-only tool: `swival-native-audit`

`extensions/index.ts` also exports `registerNativeAuditTool(pi, options)` for sessions that should expose synchronous committed-tree auditing (`swival-native-audit`) without general subagent delegation:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNativeAuditTool } from "pi-swival/extensions/index.ts";

export default function (pi: ExtensionAPI) {
  registerNativeAuditTool(pi, {});
}
```

Link `pi-swival` into the wrapper's `node_modules` and set `"extensions": []` on the `pi-swival` package entry as shown in [Optional async observation](#optional-async-observation). `swival-native-audit` accepts only `audit` plus bounded model/sampling/timeout fields (`encryptSecretsOverride` accepts only `false`) and always audits the session's Git repository root.

## Layout

```text
pi-swival/
├── extensions/
│   ├── index.ts                # swival-subagent & swival-native-audit registrars + re-exports
│   ├── contracts.ts            # option descriptors, LaunchPlan, run handles, report & native types
│   ├── agents.ts               # project > user > bundled agent discovery & validation
│   ├── args.ts                 # TypeBox schemas, frontmatter coercion, and CLI launch planner
│   ├── child-env.ts            # Swival TOML subset, credential/review env, worktree Git grants
│   ├── process.ts              # process-group spawning, trace tailing, version preflight
│   ├── report.ts               # report summarization and terminal failure classification
│   ├── artifacts.ts            # bounded O_NOFOLLOW I/O, sandbox checks, async registry
│   ├── async-observation.ts    # zero-Pi-dependency async observation coordinator
│   ├── render.ts               # TUI renderers, output writer, agent catalogue v1
│   ├── paths.ts                # canonical path, bounded-read, and semver primitives
│   ├── native-audit.ts         # native audit preparation, AgentFS launch, finalization
│   ├── native-boundary.ts      # Git snapshot importer and AgentFS write-root isolation
│   └── native-inspect.ts       # native state, coverage, and artifact verification
├── integrations/
│   └── pi-subagents.ts         # read-only Fleet & background-work adapter
├── agents/                     # six bundled Swival agent profiles
├── skills/                     # swival, auditing-with-swival, swival-worker-briefs
├── prompts/                    # /swival-audit slash-command template
├── scripts/                    # detached async runner, native route/shim helpers, smoke checks
└── tests/                      # offline Vitest and Python contract suites
```

## Development & Boundaries

Bootstrap offline test dependencies once outside `npm` (requires Node 22.19+ or 24, `uv`, Python 3.13, and an installed Pi package), then run the validation gates:

```bash
./tests/setup.sh
npm run ci
npm run native-agentfs-integration
```

Key operational boundaries:

- **Task delivery:** Tasks pass on `argv` after `--` whenever sandbox re-exec is possible; `stdin` delivery is used only with explicit `sandbox: builtin`.
- **Sandboxes & shared `cwd`:** On macOS, AgentFS `--allow <base-dir>` leaves base-directory writes write-through (see [skills/swival/references/agentfs.md](skills/swival/references/agentfs.md)). Parallel tasks may share a `cwd` only when both `files: none` and `commands: none` hold.
- **Process ownership & retention:** Only live in-memory handles signal process groups; disk-recovered runs lacking `completed.json` report `unknown`. Completed ordinary artifacts under `~/.pi/agent/swival-artifacts/` prune after 7 days; native audit artifacts are retained.

## License

[MIT](LICENSE)
