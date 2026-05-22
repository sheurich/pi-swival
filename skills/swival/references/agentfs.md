# AgentFS Sandbox

OS-enforced filesystem isolation via
[AgentFS](https://github.com/tursodatabase/agentfs). File writes go
to a session overlay stored in a SQLite database. Changes persist
across runs that reuse the same session ID.

> No automatic merge-back. The overlay stays in
> `~/.agentfs/run/<id>/delta.db` until you either reuse the session
> ID for another run or copy files out with `agentfs fs` / `agentfs
> mount`. Discard by removing the session directory. Nothing lands
> on the real filesystem unless you explicitly extract it.

## Install

Quick install (upstream one-liner):

```bash
curl -fsSL https://agentfs.ai/install | bash
```

The installer downloads a prebuilt binary from the latest GitHub
release. It works on macOS (x86_64, arm64), Windows (x86_64), and
Linux (x86_64, aarch64). No Homebrew formula exists as of AgentFS
0.6.4 — only the Turso `turso` CLI ships via their Homebrew tap.
Check the [releases
page](https://github.com/tursodatabase/agentfs/releases) for
current versions before pinning.

### Safer install (pinned + checksum-verified)

Piping a remote script into `bash` leaves you exposed to the
upstream host being compromised or to a MITM swapping the payload.
If that's a concern, download a pinned release and verify against
the published `sha256.sum` first. Pick your platform triple and
version; the `VERSION` below is known-good as of March 2026, re-check
upstream before relying on it:

```bash
VERSION=v0.6.4
TRIPLE=aarch64-apple-darwin   # or x86_64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu
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

Inspect `agentfs-installer.sh` before running it if you prefer the
scripted flow but want to audit what it does:

```bash
curl -fsSL https://agentfs.ai/install -o agentfs-installer.sh
less agentfs-installer.sh
sh agentfs-installer.sh
```

### Platform notes

On Linux the `agentfs run` overlay requires FUSE and user
namespaces. macOS uses NFS + Apple Sandbox with no additional
dependencies.

## Usage

```bash
# Run sandboxed — writes go to an overlay database, not to disk
swival --sandbox agentfs -q "Refactor the auth module"

# Inspect overlay changes
agentfs diff <session-id>
```

There is no `agentfs apply` or `agentfs reset` command. Each
`agentfs run --session <id>` stores its overlay under
`~/.agentfs/run/<id>/`:

- `delta.db` — the copy-on-write SQLite overlay.
- `mnt/` — where the overlay is mounted while the session is live.
- `base_path` (Linux) — records the base directory for the session.

Use the full `delta.db` path anywhere the AgentFS CLI accepts an
`ID_OR_PATH`:

- Keep changes for next run: reuse the same session ID;
  Swival's auto-generated IDs already do this per project.
- Discard changes: remove the session directory,
  `rm -rf ~/.agentfs/run/<id>`, or start a new session with a
  different ID.
- Inspect changes:
  `agentfs diff ~/.agentfs/run/<id>/delta.db`.
- Pull files out: during the session, read them directly
  from `~/.agentfs/run/<id>/mnt/`. After the session, use
  `agentfs fs ~/.agentfs/run/<id>/delta.db cat <path>` or
  `agentfs mount ~/.agentfs/run/<id>/delta.db <mount-point>`.

The overlay does not automatically merge back into the real
filesystem.

## Session IDs

Swival auto-generates a deterministic session ID from the project
directory. Re-running in the same directory reuses the overlay.

Override with `--sandbox-session <id>` to name sessions explicitly
or run multiple independent sessions in the same project.

Disable auto-session with `--no-sandbox-auto-session` to get a
fresh overlay every time.

## Strict read isolation

`--sandbox-strict-read` restricts reads to the allowed directories
as well as writes. The flag requires strict-read support in
AgentFS, which is not in the 0.6.x line as of 0.6.4 (March 2026);
Swival accepts the flag but AgentFS will no-op it until a release
lands support. Track
[tursodatabase/agentfs](https://github.com/tursodatabase/agentfs/releases)
for progress.

## How it works

1. Swival detects `--sandbox agentfs` and locates the `agentfs` binary.
2. It re-execs itself via `agentfs run --allow <base-dir> -- swival ...`.
3. AgentFS interposes filesystem calls at the OS level. Writes go to
   the overlay; reads see the overlay merged with the real filesystem.
4. After the session, `agentfs diff` shows changes against the base.

## Combining with other security features

```bash
# OS sandbox + self-review + secret encryption
swival --sandbox agentfs --self-review --encrypt-secrets \
  -q "Rotate credentials in config/"

# Sandbox + read-only reference directory
swival --sandbox agentfs --add-dir-ro /path/to/reference \
  -q "Port the auth pattern from the reference repo"
```
