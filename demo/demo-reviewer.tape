# pi-swival reviewer-loop demo — render with `vhs demo/demo-reviewer.tape`
#
# 90–120s walkthrough showing the headline pi-swival feature: swival's
# reviewer loop. Pi delegates to a self-review-worker agent which iterates
# until a fresh-context reviewer accepts the answer.
#
# Compare to demo-quick.tape, which uses the no-review default agent.
# Requires: vhs, pi, swival, an LLM provider configured for swival.

Output demo/demo-reviewer.gif
Output demo/demo-reviewer.mp4

Set Shell bash
Set FontSize 14
Set Width 1280
Set Height 760
Set Theme "Dracula"
Set TypingSpeed 30ms
Set WindowBar Colorful
Set Padding 16
Set Margin 16
Set MarginFill "#0a0a14"
Set WaitTimeout 60s

# ---------- Setup (hidden) ----------
Hide
Type "rm -rf /tmp/swival-demo && mkdir /tmp/swival-demo && cd /tmp/swival-demo && clear"
Enter
Sleep 500ms
Show

# ---------- 1. Frame the demo ----------
Type "# pi-swival reviewer loop — swival iterates until a reviewer accepts"
Enter
Sleep 1500ms

Type "# Each round runs in a fresh reviewer context. Output is structured."
Enter
Sleep 2s

# ---------- 2. Open Pi and dispatch through self-review-worker ----------
Type "pi --thinking off --no-session"
Enter
Sleep 4s

Type@40ms `Use swival-subagent with agent: "self-review-worker" and task: "Create greet.py with greet(name: str) -> str returning 'Hello, ' + name + '!'. Also test_greet.py with one pytest case asserting greet('world') == 'Hello, world!'. Reviewer must verify both files exist and pytest passes."`
Sleep 1s
Enter

# A self-review-worker dispatch typically takes 60–120s. 100s lets the
# round-trip finish and the structured tool block render fully on screen.
Sleep 100s

# ---------- 3. Show the artifact JSON, in-session ----------
Type@40ms `Run this jq invocation and paste the output verbatim: jq '{outcome: .result.outcome, rounds: .stats.review_rounds, tools: .stats.tool_calls_total, llm_time_s: .stats.total_llm_time_s}' "$(ls -td ~/.pi/agent/swival-artifacts/self-review-worker-* | head -1)/report.json"`
Sleep 1s
Enter

# Wait for the JSON output to render
Sleep 20s
