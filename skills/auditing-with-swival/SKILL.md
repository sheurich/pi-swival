---
name: auditing-with-swival
description: Run a source-only native Swival audit on committed repository content. Use for native audit coverage, findings, reports, and patch proposals through swival-subagent or the native-only swival-native-audit tool.
---

# Auditing with Swival

Run one structured Swival `/audit` pass on an isolated committed snapshot from Pi at the target Git repository root.

## Preconditions

- Start Pi at the target Git repository root (`cwd` overrides are rejected; open a session in another checkout to audit it).
- Compatibility manifest: Swival `1.9.3`, LiteLLM `1.106.6`, Python `>=3.13`, AgentFS `>=0.6.4`, and an installed `nono` profile (validated on macOS; Linux remains unverified).
- Confirm operator scope and provider routing before sending repository code to an external model.

## Dispatch

Use configured Swival defaults (including `active_profile`):

```json
{"audit":{"all":true}}
```

Or select an existing operator-configured profile (`security-specialist` is an illustrative profile name, not bundled):

```json
{"audit":{"all":true},"profileOverride":"security-specialist"}
```

A missing or invalid selected profile stops before launch, and any terminal route failure stops with no fallback to another model, provider, or profile. Swival may retry transient or policy errors on the same route, but `pi-swival` never substitutes another model, provider, or profile on failure. Terminal errors and incomplete phases fail closed and never attest audit completion.

Audit bounds: `paths` accepts up to 64 relative path/glob tokens without traversal or shell syntax; `workers` is `1..8`; `patchMaxTurns` is `1..100`; timeout defaults to 15 minutes (30-minute default ceiling). Native async is unsupported. Sessions using `registerNativeAuditTool` (`swival-native-audit`) accept only `audit` plus bounded model/sampling/timeout fields (`encryptSecretsOverride` accepts only `false`, admitting global `encrypt_secrets = true` while keeping the snapshot config inert).

## Route capabilities

| Provider / Route | Admission (`scripts/native_audit.py`) | Requirements |
|---|---|---|
| `chatgpt` | Admitted | Concrete model; complete interactive Swival login outside Pi beforehand; dedicated runtime-only auth-directory grant inside `HOME` (never added to `--add-dir` or model-tool roots). |
| `openrouter` | Admitted | Concrete model and `OPENROUTER_API_KEY`; loopback OpenRouter-compatible endpoints require explicit `base_url`, `max_context_tokens`, and a dedicated endpoint key. |
| `anthropic` | Admitted | Concrete model, unset `base_url`, and host-bridged `ANTHROPIC_API_KEY` or OAuth token. |
| `bedrock` | Admitted (host session export) | Concrete model, AWS region in `base_url`, and short-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` exported on the host (`aws_profile` and SDK file fallback are withheld from the child). |
| `geap` (`vertexai`) | Admitted (host ADC token) | Concrete bare model, `project`, `location`, and host-minted `GOOGLE_OAUTH_ACCESS_TOKEN` (55-minute cap; mid-run expiry or 401 fails closed with `CREDENTIAL_EXPIRED`). |
| `generic`, `lmstudio`, `llamacpp`, `applefm`, `google` | Refused (`MODEL_REPLACEMENT_UNCONTROLLABLE`) | Dynamic model-list adapters that can substitute models on not-found errors. |
| `command` | Refused (`COMMAND_EXECUTION_REQUIRED`) | Incompatible with `commands=none`. |

Preflight rejects unpropagated or unsafe controls (`POLICY_NOT_PROPAGATED` for required encryption, request filters, `extra_body`, disabled prompt caching, or strict-read isolation; `PROFILE_UNAVAILABLE`, `ROUTE_INCOMPLETE`, `CREDENTIAL_INTERFACE_UNSUPPORTED`, `CONFIG_INVALID`, `RUNTIME_UNSUPPORTED`). Stop rather than disabling required controls.

## Isolation boundary

`pi-swival` imports only committed `HEAD^{tree}` objects into a fresh temporary Git repository outside the caller's checkout, linked worktrees, and `.git` directories (staged, unstaged, and untracked files are excluded; Git hooks, filters, and ambient `GIT_*` are disabled; working-copy `swival.toml` is neutralized). Snapshot and evidence limits are `4096` entries, `8 MiB` per file, and `64 MiB` total.

Execution wraps inner Swival (`--sandbox builtin --files some --commands none --network provider-only --oneshot-commands`) inside an outer `agentfs run --no-default-allows --allow <snapshot>` boundary. Verification is strictly source-only: reviewer and patch phases cannot execute project commands, builds, tests, Python, or PoCs. On macOS, preflight rejects source or Git paths overlapping AgentFS built-in writable exceptions (`/tmp`, `/var/tmp`, `/private/var/folders`, `~/Library`; see [AgentFS reference](../swival/references/agentfs.md)). AgentFS does not provide host-read confidentiality or provider-process egress confinement.

## Lifetime and evidence

Timeout, cancellation, and normal session shutdown terminate the live owned process group and verify AgentFS session exit before exporting artifacts. After an abrupt Pi crash or `SIGKILL`, Swival may remain running with no artifact export or completion claim; disk-recovered PIDs are never probed or signaled, and native artifact directories are never auto-pruned.

Preserved artifacts under `~/.pi/agent/swival-artifacts/native-audit-*`:
- `manifest.json`, `run-meta.json`, `diagnostics.json`, and terminal status record
- `evidence/native-cli-report.json` and `evidence/native-state/<audit-id>/state.json`
- `evidence/audit-findings/<n>-<slug>.{md,patch}`

Completion requires exit `0`, verified shutdown, matching committed scope, `phase="done"`, full mandatory/deep file coverage, feasible Phase 4.5 finding lineage, non-empty report/patch pairs, and zero truncation or unrecovered adjudication errors. Review all findings and `.patch` proposals manually before applying changes.
