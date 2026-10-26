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

You also need an LLM provider configured for swival. If you already use swival from the terminal, the existing config works. Otherwise, see `skills/swival/references/setup.md` for native and local provider setup.

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

All five bundled agents (`swival`, `self-review-worker`, `test-runner`, `sandboxed-explorer`, and `a2a-coordinator`) are auto-discovered from the package's `agents/` directory.

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

## Demo 4 — native audit prompt template

Use a disposable synthetic Git repository and start Pi from its root. Require Swival 1.0.48, LiteLLM 1.105.3, Python 3.13+, AgentFS 0.6.4, upstream's nono profile, and separate approval for any live provider/auth calls. The real bootstrap/export gate passed on macOS; Linux remains unverified. Consult installation policy before execution. With no specialist selected, use configured Swival defaults. Pass a required configured specialist through `profileOverride`; a terminal selected-route failure stops without fallback. Offline representatives cover ChatGPT, API-key OpenRouter, and an explicitly configured compatible loopback endpoint. Dynamic model-list adapters are refused because upstream can replace the selected model. For ChatGPT only, standard upstream authentication can log in, refresh tokens, and write auth state. API-key/local routes receive no ChatGPT store grant. Native async is unsupported.

Swival 1.0.48 can retry the same request on the same provider, model, and endpoint, including recognized policy errors. A later attempt can succeed. The adapter does not guarantee all-phase fail-fast or uniform retry-budget propagation. Never substitute a route or rewrite a refused request. Terminal failures and incomplete audits cannot attest completion.

After a Pi crash or SIGKILL, Swival may remain running; there is no artifact export or claimed completion afterward. Normal timeout, cancellation, and session shutdown stop the live owned group. Native verification is source-only and patch proposals require manual review.

```text
/swival-audit src/**/*.py
```

Expected behaviour:

1. Pi expands the prompt and confirms relative scopes and approved routing.
2. Pi dispatches one `audit` object, not a slash-prefixed freeform task.
3. Native audit runs on an independent committed snapshot and returns preserved state, reports, and patch proposals.
4. Source contents, status, and Git refs remain unchanged.

Inspect native coverage and artifact pairs before treating the pipeline as complete. Native verifier judgment is not independently executed exploit reproduction. This demo does not prove uniform per-phase effort, and no patch applies automatically.

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
| 4 | Prompt registration and native committed-snapshot execution, when all prerequisites are met |
| 5 | Parallel task dispatch and per-task result blocks |
