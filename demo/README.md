# pi-swival demos

Two short videos that show the package end-to-end inside Pi.

| Demo | Length | What it shows |
|------|-------:|---------------|
| [`demo-quick`](demo-quick.gif) | ~60s | Pi loads pi-swival, dispatches a trivial task through `swival-subagent`, shows the structured tool block, verifies the produced file. Use this as the headline shareable. |
| [`demo-reviewer`](demo-reviewer.gif) | ~150s | The reviewer-loop differentiator. Pi consults the `swival` skill, dispatches `self-review-worker`, swival's reviewer iterates until the contract is satisfied, then Pi reads `report.json` and shows `outcome`, `rounds`, `tools`, `llm_time_s`. |

Both files render to GIF and MP4. Embed the GIF in READMEs; share the MP4 for higher-fidelity playback.

## Regenerate

```bash
# Both demos
make -C demo

# Just one
vhs demo/demo-quick.tape
vhs demo/demo-reviewer.tape
```

Each tape is a real recording — no mocks. Re-running them costs an LLM round-trip per dispatch (the reviewer demo costs more because of multiple rounds).

## Requirements

- [`vhs`](https://github.com/charmbracelet/vhs) for rendering
- `pi`, `swival`, `jq`, `bash` on PATH
- An LLM provider configured for swival (see [`skills/swival/references/setup.md`](../skills/swival/references/setup.md))

## Why two demos

The headline for pi-swival is the reviewer loop. But a 150-second demo is a hard sell on a README that scrolls past. The 60-second variant is for the embed; the long one is for anyone who wants to see the iteration play out.

For the full pipeline including AgentFS sandboxing and the audit prompt template, see the step-by-step walkthrough in [`../examples/demo.md`](../examples/demo.md).
