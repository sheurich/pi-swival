# pi-swival

Pi extension wrapping the `swival` CLI for delegated subagents, reviewer loops, and isolated native security audits.

## Repository Boundaries

- `extensions/` — Pi tool entrypoints, CLI planning, process/artifact lifecycle, TUI rendering, and native audit isolation.
- `integrations/` — Optional observation-only adapter for `pi-subagents`.
- `agents/` — Bundled Swival subagent profiles (`project > user > bundled` discovery; project scope strips privilege escalations).
- `skills/` and `prompts/` — Token-lean operator guidance and slash-command templates.
- `scripts/` and `tests/` — Standalone supervision/compatibility helpers and offline contract tests.

## Design and Code Craft

- Keep one owner per contract. Define CLI flags, launch plans, run handles, and result schemas once instead of duplicating or re-parsing them across TypeScript and Python layers.
- Keep modules small and single-purpose. Treat roughly 500 lines as a cohesion guideline, not a quota: split along ownership seams (tool routing, CLI argument construction, process ownership, bounded artifact I/O, TUI rendering, native audit boundaries), never just to hit a number.
- Trust OS, CLI, and Swival boundaries. Pass structured plans directly to child spawners rather than re-parsing emitted `argv`, hand-rolling duplicate TOML parsers, or re-implementing Swival Python internals in TypeScript.
- Fix edge cases by tightening types and boundary contracts. Do not bolt on shadow state machines, tombstone flags, unrequested config knobs, or `// Fix N:` comment scar tissue.
- Prefer `>=` minimum version checks for CLI integrations. Pin exact upstream versions only inside one explicit compatibility manifest when monkeypatching or reading private upstream state.
- Agent discovery today fails closed: a malformed or unresolvable agent file blocks dispatch, and an identifiable invalid higher-priority definition never silently falls back to a lower-priority agent. The migration goal is to warn about unrelated malformed files and block only the requested agent; keep the no-silent-fallback contract when making that change.

## Load-Bearing Invariants

- **Task `argv` delivery across sandbox re-exec:**
  Swival consumes piped `stdin` before `agentfs` or `nono` re-executes `sys.argv`. Pass delegated tasks as positional `argv` after `--` whenever re-exec is possible, including when `--sandbox` is omitted and config may select a sandbox.
  `stdin` delivery is valid only with explicit `--sandbox builtin`. Native `/audit` runs also require `--oneshot-commands`.
- **Committed-tree-only native audit isolation:**
  Native audits must import only the selected committed Git tree into a fresh temporary repository. Never run native audits against the caller's checkout, linked worktrees, or shared `.git` administration directories.
  Disable Git hooks, filters, and ambient config during snapshot creation, verify zero path overlap with caller or runtime roots, and neutralize working-copy `swival.toml` without mutating the committed tree.
- **AgentFS, `nono`, and shared-`cwd` boundaries:**
  On macOS, AgentFS leaves base-directory writes write-through at the OS layer unless tools and shell commands are restricted, and it does not isolate host-file reads. `network: provider-only` restricts agent subprocesses rather than the provider client.
  On a shared `cwd`, treat an ordinary agent as non-mutating only when both `files: none` and `commands: none` hold; a fresh AgentFS session does not make shared-`cwd` parallel writes safe.
  Native audits intentionally wrap inner Swival `--sandbox builtin --files some --commands none --network provider-only` inside an outer `agentfs` process boundary and keep credential grants out of model-tool roots.
- **SecretShield host verification:**
  When Swival `encrypt_secrets` is enabled, SecretShield replaces token-shaped source spans before model inspection.
  Treat reviewer claims based on token appearance as unverified until host-side inspection checks the cited `file:line` in unencrypted source without copying secret values into prompts or reports.
- **Live process-group ownership:**
  Separate live in-memory child handles from disk-recovered metadata. Signal process groups only through live owned handles.
  Never probe (`kill(pid, 0)`) or signal disk-recovered PIDs; report recovered runs lacking a valid `completed.json` marker as `unknown`.
- **Observation-only `pi-subagents` adapter:**
  `integrations/pi-subagents.ts` publishes read-only run and background-work status only.
  Never attach execution, result-reading, or stop authority to observers, and never promote `unknown` recovered runs to active wait items.

## Documentation and Skill Discipline

- State behavior, tradeoffs, and platform limits once in direct human prose.
- Never copy legalistic disclaimer blocks across `README.md`, `skills/`, and `prompts/`, and never lock verbatim prose with regex tests.
- Keep `SKILL.md` and `prompts/*.md` token-lean. Keep internal buffer sizes, poll intervals, and cache mechanics in code rather than user docs.
- Keep workstation-specific paths, private provider endpoints, and local user harness settings out of repository files.

## Test Discipline

- Test observable CLI flags, sandbox bootstrap checks, process-group cancellation, crash/recovery states, and fail-closed error contracts across real module boundaries.
- Do not add `ts.createProgram` string-mutation meta-tests, local test-helper self-tests, CI YAML substring checks, or verbatim Markdown prose regex policing.
- Limit documentation tests to structural checks: referenced files and bundled agents exist, frontmatter keys are valid, and config/JSON snippets parse.

## Orchestration and Delegation Workflow

- **Top-level parent sessions** act as orchestrators: delegate exploration, implementation, test-as-contract runs, and fresh-context critical review across `pi-subagents` and `swival-subagent`.
  Enforce at most one writer per worktree and obtain independent diff review before commit or merge approval.
- **Child and worker agents** (`pi-subagents` workers/reviewers and `swival-subagent` runs) execute their assigned leaf task directly with their granted tools and never recursively spawn orchestrators or reviewers.
- This file governs only sessions that load it. Bundled Swival agents such as `sandboxed-reviewer` run with `--no-instructions`, and the dispatcher's default `--no-subagents` limits recursion but does not deliver these rules. Parent briefs must therefore carry the leaf-task and no-recursive-delegation boundaries themselves; do not enable instructions merely to load this file.

## Validation

Bootstrap offline dependencies once outside `npm` (requires Node.js, `uv`, Python 3.13, and a Pi host package; set `PI_CODING_AGENT_PACKAGE` when Pi is not installed globally), then run the full CI gate and native AgentFS suite:

```sh
./tests/setup.sh
npm run ci
npm run native-agentfs-integration
```

`npm run ci` runs `npm run typecheck`, `npm run smoke`, `npm run agentfs-integration` (set `REQUIRE_AGENTFS=1` to fail rather than skip if `agentfs` is missing), and `npm test`.
