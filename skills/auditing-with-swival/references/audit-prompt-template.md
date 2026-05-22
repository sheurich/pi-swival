# Per-bucket audit prompt template

Stage 2 of the auditing-with-swival pipeline. Render this template once per bucket using fields from `recon.json`. The result is the worker's `task:` argument (after a leading `/audit\n`).

## Template

```markdown
You are a Swival security audit worker. Audit one bucket only.

Repository path: {{repository.path}}
Branch/ref: {{repository.ref}}
Commit SHA: {{repository.sha}}

Bucket: {{bucket.name}}

In scope:
{{#each bucket.in_scope}}
- {{this}}
{{/each}}

Out of scope:
{{#each global_out_of_scope}}
- {{this}}
{{/each}}
{{#each bucket.out_of_scope}}
- {{this}}
{{/each}}

Threat model and trust boundaries:
{{bucket.threat_model}}

Trust boundaries:
{{#each bucket.trust_boundaries}}
- {{this}}
{{/each}}

Read-only constraint:
- Do not create, edit, delete, format, build, test, branch, commit, or write
  files inside the repository.
- Use only read/search/list/git-read operations.

Commands posture:
- Prefer reading specific files and using rg / git grep. Do not run builds,
  tests, package managers, network clients, or formatters.

Required finding format:

If there are no concrete findings, start with exactly:

No concrete findings.

For each finding:

### <Severity>: <short title>

- Severity: Critical | High | Medium | Low
- Confidence: High | Medium | Low
- Location: `<file path>:<line or function>`
- Failure mode or exploit scenario: <specific production scenario>
- Why existing checks do not prevent it: <specific missing or insufficient check>
- Recommended fix: <actionable code or design change>
- Validation performed: <files/functions inspected, searches run, and why the evidence supports the finding>

Also include:
- False-positive notes: suspected issues investigated but not reported.
- Open questions: only questions that materially affect exploitability.
- Coverage notes: what parts of the bucket were reviewed and what was not.

Report only concrete, evidence-backed findings. Do not include speculative
hardening ideas, style issues, unreachable issues, or issues already
prevented by existing checks.
```

## Rendering

Use any templating tool available to the orchestrator. A minimal Python renderer:

```python
import json, pathlib
recon = json.loads(pathlib.Path("recon.json").read_text())
template = pathlib.Path("audit-prompt-template.md").read_text()  # the section above
for bucket in recon["buckets"]:
    rendered = render(template, {"repository": recon["repository"],
                                 "bucket": bucket,
                                 "global_out_of_scope": recon["global_out_of_scope"]})
    pathlib.Path(f"prompts/{bucket['id']}.md").write_text(rendered)
```

## Why this exact format

The Stage 3 consolidator parses headings of the form `### <Severity>: <short title>` to extract findings. Keep the format stable so consolidation stays mechanical.

The leading `/audit` (added at dispatch time, not in the template) is required by the `audit-worker` agent and gates its read-only behavior.

## Anti-patterns in template fills

- Generic threat models ("look for security bugs"). Be specific about what attacker, what input, what failure class.
- In-scope lists that include the entire repo. If the recon JSON had that, the recon stage failed.
- Omitting `Out of scope`. Workers will pull tests, vendor code, and generated files into findings without it.
- Adding "be thorough" or "find as many issues as possible". The contract already says "concrete, evidence-backed". More words don't help and they push the worker toward speculative findings.
