# Consolidation output contract — consolidated-findings.md

Stage 3 of the auditing-with-swival pipeline. The `security-consolidator` worker reads every `reports/<bucket-id>.report.md` and emits a single document matching this contract.

## Required structure

```markdown
# Security audit — <repo name> @ <commit short SHA>

## Repository

- Reference: <repo path or URL>
- Ref: <branch>
- Commit: <full SHA>
- Audit date: <ISO date>
- Buckets: <count>
- Reports inventoried: <count>

## Prioritized findings

[Findings in order: Critical → High → Medium → Low. Within severity, order by
confidence then by exploit-precondition ease (internet-facing before
admin-only). Each finding repeats the worker's content verbatim plus a
"Originating bucket" field.]

### <Severity>: <short title>

- Severity: <as reported>
- Confidence: <as reported>
- Originating bucket: <bucket-id>
- Location: <as reported>
- Failure mode or exploit scenario: <as reported>
- Why existing checks do not prevent it: <as reported>
- Recommended fix: <as reported>
- Validation performed: <as reported>

## Duplicates resolved

[Findings that appeared in 2+ buckets. List the surviving canonical entry and
the bucket(s) it was reported from. Drop one copy.]

| Title | Kept from bucket | Also reported by |
|---|---|---|
| ... | ... | ... |

## Buckets with no findings

[List bucket IDs that returned "No concrete findings." If their coverage notes
are thin, flag them here for re-dispatch.]

## Open questions and human-review items

[Aggregated from worker "Open questions" sections. Group by topic, not by
bucket. Drop questions that are answered by another bucket's finding.]

## Coverage summary

[Aggregated from worker "Coverage notes" sections. Identify gaps where a
bucket scope was not fully reviewed.]

## Suggested action sequence

[Numbered list of remediation actions in priority order. Reference originating
finding by severity + title.]
```

## Deduplication rules

Two findings are duplicates when:

- They share the same `file:line` location AND the same failure mode, OR
- They describe the same exploit chain (same attacker capability, same affected code path) even if reported with different file:line anchors.

Keep the higher-confidence report. If confidence ties, keep the higher-severity. If both tie, keep the one with more specific evidence.

Do not merge findings — keep one verbatim and discard the other. Merging confuses provenance.

## Severity rules

Use the worker's reported severity. Do not adjust it during consolidation. The consolidator's only severity-related decision is ordering.

If two workers reported the same finding with different severities, treat that as a duplicate per the rules above and keep the higher-severity report.

## What the consolidator may NOT do

- Add findings the workers did not report. The pipeline depends on findings originating in audit workers, not the consolidator.
- Speculate on exploitability beyond what the originating worker established.
- Drop findings that look implausible. If a worker reported it and a reviewer accepted it, it stays.
- Rewrite worker prose. Verbatim repetition preserves audit-trail integrity.

## What the consolidator must do

- Inventory every file under `reports/`. A missing report is a Stage-3 failure.
- Flag any bucket that returned "No concrete findings." with coverage notes shorter than 5 lines.
- Cross-reference open questions: if bucket A asks "is X reachable?" and bucket B's finding establishes that X is reachable, fold the question into B's context and remove it from the open list.
- Hash inputs: at the end of the document, list `reports/<id>.report.md` paths and their SHA-256 sums (stub these as `<computed by orchestrator>`; actual hashing happens after Stage 3).

## Anti-patterns

- Re-grading severities. The worker is the authority; the consolidator is an editor.
- Adding "we recommend..." prose that wasn't in any worker output. The consolidator suggests action sequence, not new technical content.
- Dropping coverage notes from individual reports because the summary "covers it". Per-bucket coverage notes are part of the audit trail.
- Inventing categories ("medium-low", "informational"). Use the four severities the workers used.
