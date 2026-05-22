# Recon output contract — recon.json

Stage 1 of the auditing-with-swival pipeline. The `security-recon` worker emits this file. The orchestrator parses it to fan out Stage 2.

## Schema

```json
{
  "repository": {
    "path": "<absolute path>",
    "ref": "<branch or tag>",
    "sha": "<commit SHA>",
    "language_breakdown": "<one-line summary, e.g. 90% Go 8% TypeScript 2% shell>"
  },
  "global_out_of_scope": [
    "<glob>",
    "..."
  ],
  "buckets": [
    {
      "id": "<lowercase-hyphenated-id>",
      "name": "<short human-readable name>",
      "in_scope": [
        "<glob relative to repo root>",
        "..."
      ],
      "out_of_scope": [
        "<glob>",
        "..."
      ],
      "threat_model": "<one paragraph: who can send input, where it crosses a trust boundary, what failure classes to look for>",
      "trust_boundaries": [
        "<one boundary per item>"
      ],
      "rationale": "<one paragraph: why this slice is a coherent audit unit and how it differs from siblings>"
    }
  ],
  "coverage_notes": "<what was inspected to derive the buckets, what was deliberately excluded>"
}
```

## Field rules

- `id` must be unique within `buckets[]`. Use `kebab-case`. Examples: `protocol-parsing`, `tls-crypto-keys`, `auth-purge`.
- `in_scope` globs are matched against repo-relative paths. Use `**/*.c` syntax. Bucket glob sets must be pairwise non-overlapping with other buckets' `in_scope`. Validate this in Stage 2 before dispatch.
- `out_of_scope` is bucket-specific exclusion (e.g. tests inside an otherwise-in-scope dir). `global_out_of_scope` covers the whole audit (vendor/, generated/, fuzz corpora).
- `threat_model` and `rationale` are paragraphs, not bullet lists. The auditor reading this prompt needs prose to set up its mental model.
- `trust_boundaries` is the explicit list of where untrusted data enters the bucket. Examples: "remote unauthenticated HTTP/1, 2, 3 clients", "configured FastCGI backends", "operator-supplied YAML config".

## Bucket sizing

- Aim for 4–10 buckets. Fewer than 4 means the bucket is too coarse; more than 10 means the recon is over-decomposing.
- Each bucket should fit comfortably in a single worker's context window. Rough budget: 30–80 k input tokens of code per bucket.
- Buckets must share a threat model internally. If a bucket spans both "what an internet client can do" and "what an admin can do", split it.

## Reasonable bucket starting set

When the recon worker has no prior to anchor on, start from this menu and adapt to the actual repo:

- Internet-facing request handling and input parsing
- Auth, identity, session, token, and authorization flows
- Cryptography, key handling, certificates, signing paths
- Data plane, persistence, queues, caches, state transitions
- RPC, transport security, service-to-service auth, middleware
- External integrations, webhooks, SaaS clients, credential handling
- Background jobs, schedulers, pipelines, publication flows
- CLI, admin, migration, deployment, operational tools
- Shared libraries that enforce cross-cutting invariants

Drop any that aren't present. Don't force a bucket where the code isn't there.

## Validation before Stage 2

The orchestrator must run these checks on `recon.json`:

1. Valid JSON, schema-conformant.
2. `buckets[].id` values are unique.
3. `buckets[].in_scope` globs are pairwise non-overlapping (run a quick set-intersection check).
4. The union of `in_scope` covers the production surface inferred from `language_breakdown`. If half the codebase isn't in any bucket, ask why.
5. `buckets[].threat_model` is non-empty for every bucket.

If any check fails, halt and either re-dispatch recon with corrective feedback or hand-edit the JSON.
