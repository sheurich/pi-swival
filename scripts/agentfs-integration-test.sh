#!/usr/bin/env bash
# Integration canary for the AgentFS sandbox, independent of Swival and any
# model call. Local runs skip when `agentfs` is unavailable. CI sets
# REQUIRE_AGENTFS=1 so a missing binary fails the required canary.
#
# What this proves, and what it deliberately does NOT assume:
#   - AGENTFS=1 is set inside the sandboxed process (env evidence that the
#     process is actually running under the overlay, not just that argv
#     requested it).
#   - A plain file write inside the overlay does NOT appear in the real
#     fixture filesystem (copy-on-write isolation).
#   - The overlay/diff (delta.db under ~/.agentfs/run/<session>/) exists
#     after the run, proving the session was materialized.
#   - It does NOT open a SQLite database in WAL mode inside the overlay.
#     AgentFS 0.6.4 on macOS mounts via NFS-over-localhost, which lacks the
#     shared-memory/POSIX locking SQLite WAL needs, so a WAL-mode open
#     inside the overlay is expected to fail -- asserting WAL success here
#     would contradict that known, verified limitation (see
#     dot_config/swival/config.toml.tmpl in dotfiles, which removed the
#     global `cache = true` for exactly this reason). Plain COW file writes
#     are the supported path and are what this script exercises.
set -euo pipefail

if ! command -v agentfs >/dev/null 2>&1; then
  if [[ "${REQUIRE_AGENTFS:-0}" == "1" ]]; then
    echo "FAIL: agentfs not found on PATH; required AgentFS canary cannot run." >&2
    exit 1
  fi
  echo "SKIP: agentfs not found on PATH; AgentFS integration canary not run."
  exit 0
fi

base="$(mktemp -d)"
session="${AGENTFS_CANARY_SESSION:-agentfs-ci-canary-$(python3 -c 'import secrets; print(secrets.token_hex(16))')}"
run_dir="${HOME}/.agentfs/run/${session}"
owns_run_dir=false
native_session="${session}-native"
native_run_dir="${HOME}/.agentfs/run/${native_session}"
owns_native_run_dir=false

cleanup() {
  rm -rf "$base"
  if [[ "$owns_run_dir" == true ]]; then
    rm -rf "$run_dir"
  fi
  if [[ "$owns_native_run_dir" == true ]]; then
    rm -rf "$native_run_dir"
  fi
}
trap cleanup EXIT

if [[ -e "$run_dir" ]]; then
  echo "FAIL: refusing to reuse pre-existing AgentFS session directory: ${run_dir}" >&2
  exit 1
fi

echo "=== AgentFS integration canary (session: ${session}) ==="

original_content="original-${session}"
printf '%s' "$original_content" > "${base}/original.txt"

if ! (
  cd "$base"
  agentfs run --no-default-allows --session "$session" -- \
    python3 - "$original_content" <<'PY'
import os, pathlib, sys
assert os.environ.get("AGENTFS") == "1", "AGENTFS=1 not set inside the sandbox"
cwd = pathlib.Path.cwd()
original = cwd / "original.txt"
expected = sys.argv[1]
assert original.read_text() == expected, f"sandbox cwd {cwd} does not expose the fixture sentinel"
original.write_text("changed-in-overlay")
(cwd / "overlay-only.txt").write_text("new-in-overlay")
print("agentfs-env-fixture-and-writes: OK")
PY
); then
  [[ -e "$run_dir" ]] && owns_run_dir=true
  echo "FAIL: AgentFS integration command failed." >&2
  exit 1
fi
[[ -e "$run_dir" ]] && owns_run_dir=true

# The real fixture filesystem must be untouched by the overlay writes.
if [[ "$(cat "${base}/original.txt")" != "$original_content" ]]; then
  echo "FAIL: overlay write to an existing file leaked into the real fixture filesystem" >&2
  exit 1
fi
if [[ -e "${base}/overlay-only.txt" ]]; then
  echo "FAIL: overlay-only write leaked into the real fixture filesystem" >&2
  exit 1
fi

# The overlay/diff must exist -- proof the session was materialized, not
# just that the argv requested one.
if [[ ! -e "${run_dir}/delta.db" ]]; then
  echo "FAIL: no AgentFS overlay/diff (${run_dir}/delta.db) found after the run" >&2
  exit 1
fi

echo "PASS: AGENTFS=1 observed, real fixture filesystem untouched, overlay diff present."

# Native audit uses an empty sandbox cwd and explicit write-through exceptions.
# Verify those flags with synthetic source/Git-metadata sentinels, no provider.
if [[ -e "$native_run_dir" ]]; then
  echo "FAIL: refusing to reuse a pre-existing native canary session." >&2
  exit 1
fi
if ! python3 - "$base" "$native_session" <<'PY'
import os
from pathlib import Path
import signal
import subprocess
import sys

root = Path(sys.argv[1])
sandbox = root / "sandbox"
snapshot = root / "snapshot"
evidence = root / "evidence"
source = root / "snapshot-source"
for directory in (sandbox, snapshot, evidence, source / ".git"):
    directory.mkdir(parents=True, exist_ok=True)
(source / "code.py").write_text("source-original")
(source / ".git" / "HEAD").write_text("metadata-original")
(snapshot / "code.py").write_text("snapshot-original")
probe = sandbox / "fixture.py"
probe.write_text('''import os
from pathlib import Path
import sys
assert os.environ.get("AGENTFS") == "1"
snapshot, evidence, source = map(Path, sys.argv[1:])
(snapshot / "code.py").write_text("snapshot-changed")
(evidence / "result.txt").write_text("preserved")
for target in (source / "code.py", source / ".git" / "HEAD"):
    try:
        target.write_text("must-not-reach-host")
    except OSError:
        pass
''')
argv = ["agentfs", "run", "--no-default-allows", "--allow", str(snapshot),
        "--allow", str(evidence), "--session", sys.argv[2], "--", "python3",
        str(probe), str(snapshot), str(evidence), str(source)]
# Discard child output (zero output budget) and bound its complete process tree.
with subprocess.Popen(argv, cwd=sandbox, start_new_session=True,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as child:
    try:
        code = child.wait(timeout=30)
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    assert code == 0, "native-layout AgentFS child failed"
assert (snapshot / "code.py").read_text() == "snapshot-changed"
assert (evidence / "result.txt").read_text() == "preserved"
source_unchanged = (source / "code.py").read_text() == "source-original"
metadata_unchanged = (source / ".git" / "HEAD").read_text() == "metadata-original"
if sys.platform == "darwin":
    # Native dispatch rejects this platform; do not turn this observation into
    # a success claim. Linux CI must pass both negative-write assertions.
    print("BLOCKED: native Darwin isolation is unsupported; "
          f"source_unchanged={source_unchanged}, metadata_unchanged={metadata_unchanged}.")
else:
    assert source_unchanged, "native-layout source write reached host"
    assert metadata_unchanged, "native-layout Git-metadata write reached host"
    print("PASS: native-layout write exceptions persist; source and Git metadata stay unchanged.")
PY
then
  [[ -e "$native_run_dir" ]] && owns_native_run_dir=true
  echo "FAIL: native-layout AgentFS isolation canary failed." >&2
  exit 1
fi
[[ -e "$native_run_dir" ]] && owns_native_run_dir=true
