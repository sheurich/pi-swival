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

All five bundled agents (`swival`, `self-review-worker`, `test-runner`, `sandboxed-explorer`, and `a2a-coordinator`) are auto-discovered from the package's `agents/` directory.

## Demo 1: generic delegation

Open Pi in a disposable directory and confirm that `/tmp/swival-demo.txt` can be overwritten. Ordinary paths are caller-selected, not restricted to approved roots. Delegation does not promise confidentiality. If file policy excludes `/tmp`, use a disposable file within the selected cwd instead:

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

Use a disposable cwd and disposable target files. Swival 1.9.3 can permit AgentFS host-base write-through through `--allow <base-dir>`. See [AgentFS platform behavior](../skills/swival/references/agentfs.md) for the Linux overlay distinction. Fresh sessions do not prevent those writes. Use the explorer only with disposable files; its session does not isolate host-base writes.

Prerequisite: `agentfs` installed (see `skills/swival/references/agentfs.md`). Set `cwd` to your disposable directory on the following call. Keep a separate copy if you want to compare the original file.

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

Use a disposable synthetic Git repository and start Pi from its root. Require Swival 1.9.3, LiteLLM 1.106.6, Python >=3.13,<3.15, AgentFS 0.6.4, upstream's nono profile, and separate approval for any live provider/auth calls. The real bootstrap/export gate passed on macOS; Linux remains unverified. Consult installation policy before execution. With no specialist selected, use configured Swival defaults. Pass a required configured specialist through `profileOverride`; a terminal selected-route failure stops without fallback. Offline representatives cover ChatGPT, API-key OpenRouter, and an explicitly configured compatible loopback endpoint. Dynamic model-list adapters are refused because upstream can replace the selected model. For ChatGPT only, standard upstream authentication can log in, refresh tokens, and write auth state. API-key/local routes receive no ChatGPT store grant. Native async is unsupported.

Swival 1.9.3 can retry the same request on the same provider, model, and endpoint, including recognized policy errors. A later attempt can succeed. The adapter does not guarantee all-phase fail-fast or uniform retry-budget propagation. Never substitute a route or rewrite a refused request. Terminal failures and incomplete audits cannot attest completion.

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

## Demo 5: parallel dispatch

Prepare two distinct disposable directories first. Add a different per-task `cwd` to each item below and use targets within those directories. The abbreviated example omits those required paths; do not dispatch it unchanged. The same-cwd guard rejects these ordinary writable tasks. It also rejects fresh AgentFS sessions sharing a writable cwd because they can still permit host-base writes.

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

## What to check

| Demo | Validates |
|------|-----------|
| 1 | Extension loads, `swival-subagent` tool dispatches, default agent works |
| 2 | Reviewer loop runs, structured report parsed |
| 3 | AgentFS session inspection and direct host-file checks, without a COW-isolation claim |
| 4 | Prompt registration and native committed-snapshot execution, when all prerequisites are met |
| 5 | Parallel task dispatch and per-task result blocks |
