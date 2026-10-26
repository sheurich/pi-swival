# AgentFS sandbox

[AgentFS](https://github.com/tursodatabase/agentfs) supplies an overlay and platform filesystem sandbox. Swival 1.0.48 invokes it with `--no-default-allows --allow <base-dir>`. That absolute base directory has write-through access to the host. Do not assume all Swival writes stay in `delta.db` or that a fresh session prevents host-base mutation.

For native audit, the adapter launches upstream AgentFS directly with `--no-default-allows` and a disposable committed snapshot grant. ChatGPT alone also receives a dedicated auth-store directory grant inside HOME. API-key/local routes receive no ChatGPT directory grant. Auth cannot overlap source, artifacts, or prospective AgentFS/service state, including all of HOME's `.agentfs`. These explicit grants are not the entire upstream write policy. The auth directory never enters Swival `--add-dir` or model-tool roots. Swival uses `--sandbox builtin` inside AgentFS to avoid a second bootstrap. Original source and Git metadata stay outside the writable scope. After verified shutdown, the adapter reads bounded artifacts from the snapshot. It does not export from guessed delta paths or automatically apply patches.

AgentFS does not establish host-read confidentiality or provider-process egress confinement. `network=provider-only` is Swival's tool policy. The installed runtime remains trusted.

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

`--sandbox-strict-read` is unsupported and refused by Swival 1.0.48 with AgentFS 0.6.4. No released AgentFS version in the tested contract supplies this feature. Do not describe it as an effective read boundary.

## Native validation

Run `npm run native-agentfs-integration` with existing prerequisites. The gate uses isolated synthetic homes, source, Git metadata, and nono registration. It exercises real CLI bootstrap, original-source write refusal, process/session teardown, and production bounded snapshot collection. It makes no live provider/auth calls. API/local cases run the released zero-finding audit producer and resolver with HTTP doubles through production launch/finalization. ChatGPT controls exercise standard synthetic refresh persistence and model-tool auth denial. Full finding/verifier/patch phases run separately in offline fixtures. Synthetic registration proves profile availability only, not authenticity or nono enforcement.
