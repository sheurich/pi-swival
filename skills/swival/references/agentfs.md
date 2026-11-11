# AgentFS sandbox

[AgentFS](https://github.com/tursodatabase/agentfs) supplies an overlay and platform filesystem sandbox. Swival 1.9.3 invokes it with `--no-default-allows --allow <base-dir>`. On macOS, that grant permits host-base write-through. On Linux, AgentFS 0.6.4 overlays its launch cwd before applying grants, so an identical base path remains in the overlay. Do not assume all Swival writes stay in `delta.db` or that a fresh session prevents host-base mutation.

For native audit, `pi-swival` launches AgentFS directly with `--no-default-allows` and a disposable committed snapshot grant (plus a runtime-only auth-store directory inside `HOME` for ChatGPT, excluded from Swival `--add-dir` and model-tool roots). Inner Swival runs `--sandbox builtin` to avoid a second bootstrap, keeping original source and `.git` metadata outside writable scope. Artifacts are read from the snapshot only after verified process-group shutdown.

AgentFS does not provide host-read confidentiality or provider-process egress confinement (`network=provider-only` confines agent subprocesses rather than the provider client).

## Ordinary delegation

Use a disposable `cwd` for write exploration: a fresh AgentFS session (`noSandboxAutoSession: true`) separates session state, not Swival's `--allow <base-dir>` grant. Parallel writable tasks require distinct disposable directories or worktrees; only agents with both `files: none` and `commands: none` may share a `cwd`.

## Native source locations

The [AgentFS 0.6.4 Darwin policy](https://github.com/tursodatabase/agentfs/blob/3a5ed2b88e5d5a5f9b2c7fe02d012b50fd19e3c0/cli/src/sandbox/darwin.rs#L98-L157) also permits `/private/tmp`, `/tmp`, `/var/tmp`, `/private/var/folders`, `/dev`, `/private/var/db/mds`, HOME's `Library`, `/Library/Preferences`, `/Library/Keychains`, and the active AgentFS session directory. The banner omits several of these exceptions.

Native preflight refuses source worktrees, worktree Git directories, or common Git directories overlapping these paths. It resolves symlinks and compares directory identities to catch aliases such as `/tmp` and `/private/tmp`. Source must remain outside these writable exceptions. The adapter does not change the upstream policy. Linux remains unverified by the native mechanism gate.

## Installation

Review the [release assets](https://github.com/tursodatabase/agentfs/releases) and verify the selected binary before installing it. AgentFS 0.6.4 is the version exercised by the native macOS bootstrap/export fixture. Linux requires its own passing native gate before a portability claim.

Example checksum verification for a selected release:

```bash
VERSION=v0.6.4
TRIPLE=aarch64-apple-darwin
BASE=https://github.com/tursodatabase/agentfs/releases/download/$VERSION

curl -fsSLO "$BASE/agentfs-$TRIPLE.tar.xz"
curl -fsSLO "$BASE/sha256.sum"

if command -v sha256sum >/dev/null 2>&1; then
  grep " agentfs-$TRIPLE.tar.xz\$" sha256.sum | sha256sum -c -
elif command -v shasum >/dev/null 2>&1; then
  grep " agentfs-$TRIPLE.tar.xz\$" sha256.sum | shasum -a 256 -c -
else
  echo "Need sha256sum or shasum to verify checksum" >&2
  exit 1
fi

tar -xJf "agentfs-$TRIPLE.tar.xz"
mkdir -p ~/.local/bin
install -m 0755 "agentfs-$TRIPLE/agentfs" ~/.local/bin/agentfs
```

Installation changes require operator approval. Do not install prerequisites to make an audit proceed without that approval.

## Sessions and inspection

Swival normally derives a reusable session ID from the project directory. `--sandbox-session <id>` selects an explicit session; `--no-sandbox-auto-session` disables deterministic reuse. Native audit supplies a new random session and refuses reuse.

Session data lives under `~/.agentfs/run/<id>/`, including `delta.db` and the live mount. Inspect active sessions with `agentfs ps`, and inspect an owned session with `agentfs diff <id>`. Overlay changes do not automatically merge back, but writes through an explicit `--allow` path already affect the host.

Do not delete session data or signal recorded PIDs while a process may still use it. Native crash resources remain retained for manual inspection. The adapter never resurrects ownership from disk.

## Strict-read isolation

`--sandbox-strict-read` is unsupported and refused by Swival 1.9.3 with AgentFS 0.6.4. No released AgentFS version in the tested contract supplies this feature. Do not describe it as an effective read boundary.

## Native validation

Run `npm run native-agentfs-integration` to exercise offline AgentFS bootstrap, original-source write refusal, process-group teardown, and bounded snapshot artifact collection against local HTTP doubles without live provider calls.
