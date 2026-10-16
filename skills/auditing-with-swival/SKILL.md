---
name: auditing-with-swival
description: Run a source-only native Swival audit on committed repository content. Use for native audit coverage, findings, reports, and patch proposals through swival-subagent.
---

# Auditing with Swival

Use the structured `audit` API from Pi at the target Git repository root. The adapter invokes one upstream CLI `/audit` request. It validates coverage and artifacts so the operator does not need to reconstruct completion from console output. The offline fixtures exercise released phases and rejected incomplete states. The operator still reviews findings and every patch.

## Preconditions and selection

- Confirm scope and the operator's provider and data boundaries before sending source to a provider.
- Consult installation guidance before execution. Use its authorized specialist through existing `profileOverride` when required. Do not infer specialization from vendors, model names, or profile-name substrings.
- With no specialist selected, use configured Swival defaults, including `active_profile`. A missing or invalid selected specialist stops before launch. A terminal selected-route failure stops without fallback; never retry without the selected specialist.
- Require Swival 1.0.46, LiteLLM 1.103.4, Python 3.13+, AgentFS 0.6.4, and upstream's installed nono profile. Other versions fail closed. The real bootstrap/export gate passed on macOS; Linux remains unverified.
- Configuration inspection does not prove account access. Do not send repository content to probe specialist access. There is no fallback to another model, provider, endpoint, account, profile, or sandbox.

## Dispatch

Use configured provider/model defaults:

```json
{"audit":{"all":true}}
```

Select an existing operator-configured specialist profile when installation policy requires it:

```json
{"audit":{"all":true},"profileOverride":"security-specialist"}
```

`security-specialist` is illustrative, not bundled or reserved. Explicit profile selection outranks `active_profile`. Authorized explicit field overrides outrank profile values. Do not add provider/model/effort overrides automatically; inherit selected settings. Reject conflicts with installation policy before execution. Ordinary inherited effort is best-effort; auxiliary phases can omit it.

Swival 1.0.46 can retry the same request on the same provider, model, and endpoint, including recognized policy errors. A later attempt can succeed. The adapter does not guarantee all-phase fail-fast or uniform retry-budget propagation. Never substitute a route or rewrite a refused request. Terminal failures and incomplete audits cannot attest completion.

## Route capabilities

Support means a Swival-supported route meeting required native policies on the pinned runtime, not a promise that every route/version works. Swival owns provider/auth integration.

| Route | Native requirements |
| --- | --- |
| Configured ChatGPT | Concrete model; standard upstream auth; dedicated runtime-only auth-directory grant. |
| API-key OpenRouter | Concrete model; selected `OPENROUTER_API_KEY`; no ChatGPT directory or grant. |
| Explicit OpenRouter-compatible loopback endpoint | Deliberately configured adapter/model/`base_url`, `max_context_tokens`, and a dedicated endpoint key through `OPENROUTER_API_KEY`; no remote-key inheritance or automatic conversion. |
| Dynamic model-list adapters, including generic, LMStudio, llama.cpp and Google's generic transport | Refused with `MODEL_REPLACEMENT_UNCONTROLLABLE`: this runtime can replace a selected model after model-not-found. |
| Other Swival routes | Evaluate credential authority, command execution, replacement, and policy requirements. Additional credential directories are not granted. |

Automatic/multi-model selectors are unsupported. Client evidence does not prove backend alias resolution or routing. Configure local endpoints deliberately; never convert a rejected generic route to another adapter. Supply only that endpoint's dedicated credential, not a remote account key.

Preflight returns bounded, value-free codes, including `PROFILE_UNAVAILABLE`, `ROUTE_INCOMPLETE`, `CREDENTIAL_INTERFACE_UNSUPPORTED`, `CONFIG_INVALID`, and `RUNTIME_UNSUPPORTED`. `POLICY_NOT_PROPAGATED` names recognized requirements omitted by native or auxiliary phases: encryption, secret shielding, request filtering, `extra_body`, disabled prompt caching, thinking controls, strict-read/session isolation, or strict all-phase effort/retry requirements. Inline keys, custom headers, cloud/file/command credential requirements, credential-bearing URLs, ambient endpoints, and proxies fail closed. Stop instead of disabling controls.

For ChatGPT only, standard upstream ChatGPT authentication permits login, token refresh, and auth-state writes. Complete interactive login with upstream Swival outside Pi before an audit. Device-login challenges cancel without exposing their contents. Refresh and persistence use upstream auth unchanged. The adapter checks metadata, never auth-store contents. API-key/local routes create no ChatGPT store and forward no ChatGPT variables.

`paths` accepts at most 64 relative path/glob tokens without spaces, traversal, shell syntax, or host paths. Omit it for the auditable committed scope. `all` requires deep review of every selected file. `workers` is 1–8 pipeline workers, not autonomous subagents. `patchMaxTurns` is 1–100 turns per patch loop. The default timeout is 15 minutes; the default operator ceiling is 30 minutes.

Native async is unsupported. Do not combine `audit` with `task`, `agent`, `cwd`, parallel/chain dispatch, output routing, reviewer settings, extra arguments, or permission overrides. Ordinary freeform delegation is separate and does not attest native completion. Do not use freeform slash-command tasks as a substitute.

## Boundary

The adapter imports only committed Git objects into a separate disposable repository outside the original source checkout and Git metadata. It disables source hooks, filters, lazy fetches, and remotes. It excludes staged, unstaged, and untracked content. The synthetic snapshot commit preserves the source tree, not its history. A tracked `swival.toml` remains auditable from HEAD; its runtime copy and the run's global configuration are inert.

The adapter launches upstream AgentFS directly with a fresh session. Swival uses `--sandbox builtin` inside AgentFS to avoid a second bootstrap, with `commands=none`, `files=some`, and `network=provider-only`. Instructions, skills, metaskills, MCP, A2A, autonomous subagents, lifecycle hooks, history, continuation, and memory are disabled. Verifier and patch loops inherit command and network restrictions. They cannot run project commands, builds, tests, Python, fetch tools, or PoCs. Describe verification as source-only judgment, not executed exploit reproduction.

The adapter explicitly grants AgentFS write-through access to the snapshot. For ChatGPT only, it also grants a dedicated auth-store directory inside HOME. The default store is `~/.config/litellm/chatgpt/auth.json`. Safe `CHATGPT_TOKEN_DIR` and basename-only `CHATGPT_AUTH_FILE` selections are supported. Broad, shared, linked, or source/artifact/runtime-overlapping stores fail closed, including future paths under HOME's `.agentfs` and service directories. The auth directory never enters Swival `--add-dir` or model-tool roots. The adapter collects artifacts from the snapshot after verified normal shutdown; it does not claim COW-only export. Upstream also grants built-in temporary, service, and session paths. On macOS, source and Git metadata must not overlap those exceptions, including `/tmp`, `/var/tmp`, `/private/var/folders`, and HOME's `Library`. The adapter checks canonical paths and directory identities before launch. See the [complete AgentFS restriction](../swival/references/agentfs.md). The original source and Git metadata remain protected. AgentFS does not provide host-read confidentiality or provider-process egress confinement. The extension and installed runtime remain trusted.

Snapshot and evidence limits are 4096 entries, 8 MiB per object/file, and 64 MiB total. Unsupported tracked links, unsafe paths, recognized credential content, protected configuration, and oversized inputs fail closed. Scanning cannot prove that source contains no secrets.

## Lifetime and evidence

Timeout, cancellation, and normal Pi session shutdown stop the live owned process group with bounded TERM/KILL escalation. Before export, the adapter requires process-group absence, drained diagnostics, and no active AgentFS session. Unverified shutdown retains the snapshot without export.

After a Pi crash or SIGKILL, Swival may remain running. There is no artifact export or claimed completion afterward. Native runs never resume from disk, signal recovered PIDs, or use a guardian. Preserve crash resources for manual inspection. Normal completion removes the snapshot and run-local configuration; AgentFS session metadata remains retained. Native artifact directories are not automatically pruned.

The returned artifact directory contains `manifest.json`, `run-meta.json`, `diagnostics.json`, a terminal record, and `evidence/native-cli-report.json`. Audit state lives under `evidence/native-state/<audit-id>/state.json`; finding reports and patches live under `evidence/audit-findings/`. Diagnostics retain bounded counters, not raw login output. A failed terminal write uses `spawn-error.txt`; failure of both writes leaves completion unknown.

Exit zero and a plausible answer are insufficient. Completion requires matching committed scope, CLI route and policy, `phase=done`, mandatory/deep coverage, terminal verification states, feasible finding lineage, unique report/patch pairs, and complete diagnostics without lost expansion warnings. Missing, empty, reused, symlinked, oversized, truncated, or incomplete evidence cannot attest completion. Complete zero-finding state means the pipeline finished, not that the code is secure.

Compare source content, status, and refs with their initial values. Review patches manually. Do not apply patches or begin remediation without separate approval. Use `self-review-worker` only for approved implementation work.

## Validation

Run `npm run native-agentfs-integration` with existing prerequisites and isolated synthetic fixtures. It tests the production launcher/finalizer with real AgentFS, released API/local zero-finding audit producers and HTTP doubles, plus synthetic ChatGPT refresh/model-tool-denial controls. Full finding/verifier/patch phases run separately with real upstream route resolution and synthetic LLM responses. Synthetic nono registration proves availability, not authenticity. These tests make no live provider or auth calls.

Live provider or authentication tests require separate approval. Never install missing prerequisites, broaden network policy, or replace a rejected route to make a test pass.
