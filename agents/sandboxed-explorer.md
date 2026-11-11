---
name: sandboxed-explorer
description: Explores with AgentFS and self-review. Base-directory access can be write-through in Swival 1.9.3; use a disposable worktree for exploratory changes. Use `sandboxed-reviewer` instead for read-only reviews.
sandbox: agentfs
noSandboxAutoSession: true
selfReview: true
files: some
commands: all
noInstructions: true
noMemory: true
---

Swival 1.9.3 can permit write-through access to the allowed base directory.
A fresh AgentFS session does not isolate writes to that directory. Changes
can modify real files immediately; `agentfs diff` is not a complete record
of write-through changes.

Use a disposable worktree for exploratory edits. Do not assume that changes
wait for the caller to apply them. List every file you modified in your
final summary.
