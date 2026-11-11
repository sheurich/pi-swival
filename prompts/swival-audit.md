---
description: Run one source-only native Swival audit on Pi's committed repository
argument-hint: "[relative paths or globs]"
---

Audit the current Git repository root with requested relative scopes: $ARGUMENTS

1. Load the `auditing-with-swival` skill and confirm scope (`audit.paths` when `$ARGUMENTS` is non-empty, or `audit.all: true` for the committed tree) plus any operator-configured specialist `profileOverride`:

```json
{"audit":{"all":true}}
```

```json
{"audit":{"all":true},"profileOverride":"security-specialist"}
```

2. Dispatch one synchronous structured `audit` call from the session's Git root (`cwd`, `task`, `async`, and route fallbacks are prohibited).
3. Verify native `state.json` completion, coverage, and `evidence/audit-findings/` report/patch pairs, then summarize verified source-only findings, artifact directory, and committed tree SHA without applying patches automatically.
