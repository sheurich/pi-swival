# Demo: pi-swival end to end

A short walkthrough that exercises every piece pi-swival contributes to Pi:
the `swival-subagent` tool, the bundled agents, the `swival` skill, and the
`/swival-audit` prompt template.

Run the steps in order. Each step prints a marker so you can verify Pi
loaded the package correctly.

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

You also need an LLM provider configured for swival. If you already use
swival from the terminal, the existing config works. Otherwise see
`skills/swival/references/setup.md` for the full setup including the
optional litellm proxy.

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

All seven bundled agents (`swival`, `self-review-worker`, `test-runner`,
`sandboxed-explorer`, `audit-worker`, `security-recon`,
`security-consolidator`) are auto-discovered from the package's `agents/`
directory — no symlinks needed.

## Demo 1 — generic delegation

Open Pi in any directory and ask it to delegate a trivial task:

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
- Swival's normal answer + report flow (no review, no sandbox).

## Demo 2 — reviewer loop

Ask for a change that benefits from a second pass. The
`self-review-worker` agent has `selfReview: true` and a 5-round budget.

```text
Use swival-subagent with agent: "self-review-worker"
and task: "Write a Python script /tmp/fizzbuzz.py that prints 1..15 with
FizzBuzz. After writing, also write a sibling test_fizzbuzz.py with at
least four pytest cases covering 3, 5, 15, and a non-multiple."
```

Expected behaviour:

1. Pi reports `✓ self-review-worker  <model> · N rounds · M tool calls · ...`
   where N is at least 1 (the reviewer ran).
2. Both files exist and are correct.

If swival rejects the first answer, the header shows `1 rounds` or more.
If the reviewer is satisfied immediately, it shows `0 rounds`.

## Demo 3 — sandboxed exploration (AgentFS)

Run a destructive-looking task without touching the real filesystem.

Prerequisite: `agentfs` installed (see `skills/swival/references/agentfs.md`).

```text
Use swival-subagent with agent: "sandboxed-explorer"
and task: "Refactor /tmp/fizzbuzz.py to use a single-pass for loop
with sys.stdout.write."
```

Expected behaviour:

1. Pi reports the header with the sandbox session id.
2. `cat /tmp/fizzbuzz.py` shows the original file unchanged.
3. `agentfs diff <session-id>` shows the would-be refactor.

This is the key value of `sandboxed-explorer`: you see what swival would
do, then decide whether to apply it.

## Demo 4 — security audit prompt template

Run the `/swival-audit` prompt template against a small public repo. The
template walks Pi through the recon → per-bucket → consolidate pipeline
documented in the `auditing-with-swival` skill.

```text
/swival-audit https://github.com/example-org/some-small-repo
```

Expected behaviour:

1. Pi expands the slash command into the audit walkthrough prompt.
2. Pi clones the repo, inspects layout, and asks clarifying questions.
3. After you confirm, Pi dispatches `audit-worker` agents per bucket.

For a faster demo without an external clone:

```text
/swival-audit /path/to/a/local/repo "Audit only the HTTP handlers,
skip everything else."
```

## Demo 5 — parallel dispatch

Confirm the `tasks[]` mode works:

```text
Use swival-subagent with tasks: [
  { agent: "self-review-worker", task: "Add a docstring to /tmp/fizzbuzz.py" },
  { agent: "self-review-worker", task: "Add type hints to /tmp/test_fizzbuzz.py" }
]
```

Both tasks run in parallel. Pi reports a per-task block for each.

## Tearing down

```bash
rm -f /tmp/swival-demo.txt /tmp/fizzbuzz.py /tmp/test_fizzbuzz.py
pi remove pi-swival
```

## What this demo proves

| Demo | Validates |
|------|-----------|
| 1 | Extension loads, `swival-subagent` tool dispatches, default agent works |
| 2 | Reviewer loop runs, structured report parsed |
| 3 | AgentFS sandbox isolates writes |
| 4 | `/swival-audit` prompt template registers, audit pipeline agents dispatch |
| 5 | Parallel task dispatch and per-task result blocks |
