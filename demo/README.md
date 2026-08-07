# pi-swival demos

These live recordings run Pi and pi-swival without mocks.

| Demo | Length | What it shows |
|------|-------:|---------------|
| [`demo-quick`](demo-quick.gif) | ~70s | A failing pytest run, a delegated repair via `self-review-worker`, reviewer acceptance, and the same tests passing. This is the headline README demo. |
| [`demo-reviewer`](demo-reviewer.gif) | ~75s | `self-review-worker` creates two Python files, runs pytest, and completes after Swival's reviewer accepts the result. |

Each recording is available as GIF and MP4. Use the GIF in Markdown and the MP4 for higher-fidelity playback.

## Safe recording environment

Run recordings through `record.sh`, not `vhs` directly. The script:

- archives the current `HEAD` into a disposable checkout;
- creates a disposable home containing only the selected Pi and Swival credentials plus an explicit Swival provider/model pair;
- starts Pi under `env -i` with ambient extensions, skills, prompts, themes, context files, and built-in tools disabled;
- loads only `pi-swival`'s extension and allows only `swival-subagent`;
- removes the temporary checkout, home, and launcher on exit.

The tapes show only neutral temporary paths. They do not display local resource inventories, credential values, or artifact directories.

## Regenerate

Requirements:

- [`vhs`](https://github.com/charmbracelet/vhs), `pi`, `swival`, `git`, `jq`, `node`, `npm`, `python3` (with `pytest` installed), `tar`, and Bash on `PATH`;
- Pi auth-file entries for the selected Pi and Swival providers;
- `shellcheck` when running `make -C demo check`.

Set both provider/model pairs, then run Make:

```bash
PI_SWIVAL_DEMO_PROVIDER="$PI_PROVIDER" \
PI_SWIVAL_DEMO_MODEL="$PI_MODEL" \
PI_SWIVAL_DEMO_SWIVAL_PROVIDER="$SWIVAL_PROVIDER" \
PI_SWIVAL_DEMO_SWIVAL_MODEL="$SWIVAL_MODEL" \
make -C demo
```

If either auth-file key differs from its provider name, set `PI_SWIVAL_DEMO_AUTH_PROVIDER` or `PI_SWIVAL_DEMO_SWIVAL_AUTH_PROVIDER`. The `chatgpt` Swival provider requires an OAuth Pi auth entry. Other supported Swival providers require an API-key entry. Set `PI_SWIVAL_DEMO_SWIVAL_BASE_URL` only when the selected provider needs an explicit endpoint. Recording data defaults to `/tmp`; set `PI_SWIVAL_DEMO_TMPDIR` only to another neutral path because Pi displays the working directory.

`record.sh` compares `pi --version` with npm's latest published version and refuses to record if they differ. Rendering uses live model calls. Each demo starts one Pi session and one Swival self-review run, so cost and duration vary by model.

Validate the harness and both tapes without model calls:

```bash
make -C demo check
```

For the full pipeline, including AgentFS sandboxing and the audit prompt template, see [`../examples/demo.md`](../examples/demo.md).
