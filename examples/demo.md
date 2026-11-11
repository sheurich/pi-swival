# Demo: pi-swival end to end

This walkthrough covers `swival-subagent`, reviewer loops, AgentFS session inspection, and the `/swival-audit` prompt template.

Run the steps in order using disposable files. Expected results depend on your configured runtime and provider.

## Prerequisites

```bash
# Pi
npm install -g @earendil-works/pi-coding-agent

# Swival (the CLI this package wraps)
uv tool install swival
# or: pipx install swival

# Verify
pi --version
swival --version
```

Use Swival 1.9.3, LiteLLM 1.106.6, and Python >=3.13,<3.15; operational tests use Python 3.13. The installation commands above are unpinned. You also need an LLM provider configured for Swival. If you already use swival from the terminal, the existing config works. Otherwise, see `skills/swival/references/setup.md` for native and local provider setup.

## Install the package

Pick one of:

```bash
# From GitHub (preferred for users)
pi install https://github.com/sheurich/pi-swival

# From a local checkout (preferred for development)
pi install /path/to/pi-swival
```

Confirm it shows up in your settings:

```bash
pi list | grep pi-swival
```

All six bundled agents (`swival`, `self-review-worker`, `test-runner`, `sandboxed-reviewer`, `sandboxed-explorer`, and `a2a-coordinator`) are auto-discovered from the package's `agents/` directory.

## Demo 1: generic delegation

Open Pi in a disposable directory where `/tmp/swival-demo.txt` can be written:

```text
Use swival-subagent with task: "Print 'hello from swival' to a file
called /tmp/swival-demo.txt"
```

Expected behaviour:

1. Pi calls the `swival-subagent` tool.
2. Pi reports a header line such as `✓ swival  <model> · 0 rounds · 1 tool calls · 1.4s · accepted`.
3. The file `/tmp/swival-demo.txt` exists with the expected content.

This exercises:

- The `swival-subagent` tool registration (extension load).
- The default `swival` agent (selected when no `agent` is named).
- Swival's normal answer and report flow without agent-requested review or sandbox settings; ambient Swival configuration still applies.

## Demo 2: reviewer loop

Confirm that `/tmp/fizzbuzz.py` and `/tmp/test_fizzbuzz.py` are disposable. The `self-review-worker` agent has `selfReview: true` and a five-round retry budget.

```text
Use swival-subagent with agent: "self-review-worker"
and task: "Write a Python script /tmp/fizzbuzz.py that prints 1..15 with
FizzBuzz. After writing, also write a sibling test_fizzbuzz.py with at
least four pytest cases covering 3, 5, 15, and a non-multiple."
```

Expected behaviour:

1. Pi reports `✓ self-review-worker  <model> · N rounds · M tool calls · ...`. The round count records retries, not whether review occurred.
2. Both files exist and are correct.

If swival rejects the first answer, the header shows `1 rounds` or more. If the reviewer is satisfied immediately, it shows `0 rounds`.

## Demo 3: sandboxed exploration (AgentFS)

Prerequisite: `agentfs` installed (see [skills/swival/references/agentfs.md](../skills/swival/references/agentfs.md)). Pass a disposable `cwd` because Swival's `--allow <base-dir>` leaves macOS host-base writes write-through even with a fresh session:

```text
Use swival-subagent with agent: "sandboxed-explorer"
and task: "Refactor /tmp/fizzbuzz.py to use a single-pass for loop
with sys.stdout.write."
```

Expected behaviour:

1. Inspect the result's sandbox report for the session identifier or diff hint.
2. Inspect `/tmp/fizzbuzz.py` directly; host write-through can change it.
3. `agentfs diff <session-id>` shows overlay changes only, so it cannot prove that host files stayed unchanged.

Review direct file changes alongside any overlay diff. Native audit uses a separate committed snapshot; ordinary explorer sessions do not provide that source boundary.

## Demo 4: native audit prompt template

Start Pi at the root of a disposable Git repository (requires the pinned runtime in the compatibility manifest in [skills/auditing-with-swival/SKILL.md](../skills/auditing-with-swival/SKILL.md)):

```text
/swival-audit src/**/*.py
```

Expected behaviour:

1. Pi expands `/swival-audit` and confirms relative scopes plus any operator-configured `profileOverride`.
2. Pi dispatches one synchronous structured `audit` call (never a freeform slash-command task).
3. Native audit imports only committed `HEAD` objects into an isolated snapshot and exports verified `state.json`, finding reports, and `.patch` proposals after process-group shutdown.
4. Original checkout files, status, and Git refs remain untouched; review proposed patches manually before applying.

## Demo 5: parallel dispatch

Pre-create two distinct disposable directories or Git worktrees (`cwd` per task) so parallel write-capable agents do not share a working copy:

```text
Use swival-subagent with tasks: [
  { agent: "self-review-worker", cwd: "/tmp/demo-a", task: "Add a docstring to fizzbuzz.py" },
  { agent: "self-review-worker", cwd: "/tmp/demo-b", task: "Add type hints to test_fizzbuzz.py" }
]
```

Both tasks run in parallel. Pi reports a per-task block for each.

## Tearing down

```bash
rm -f /tmp/swival-demo.txt /tmp/fizzbuzz.py /tmp/test_fizzbuzz.py
pi remove pi-swival
```

## What to check

| Demo | Validates |
|------|-----------|
| 1 | Extension loads, `swival-subagent` tool dispatches, default agent works |
| 2 | Reviewer loop runs, structured report parsed |
| 3 | AgentFS session inspection and direct host-file checks, without a COW-isolation claim |
| 4 | Prompt registration and native committed-snapshot execution, when all prerequisites are met |
| 5 | Parallel task dispatch and per-task result blocks |
