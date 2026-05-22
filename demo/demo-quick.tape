# pi-swival quick demo — render with `vhs demo/demo-quick.tape`
#
# 30–40s walkthrough showing Pi delegating a trivial task to swival via
# the swival-subagent tool. Captures the structured swival report block
# inline in Pi's TUI.
#
# For the reviewer-loop variant (longer, ~90s) see demo-reviewer.tape.
# Requires: vhs, pi, swival, an LLM provider configured for swival.

Output demo/demo-quick.gif
Output demo/demo-quick.mp4

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
Type "cd /Users/sheurich/src/sheurich/pi-swival && clear"
Enter
Sleep 500ms
Show

# ---------- 1. Package overview ----------
Type "# pi-swival — Pi package wrapping swival's reviewer loop and sandbox"
Enter
Sleep 1500ms

Type "ls"
Enter
Sleep 2500ms

Type "head -22 package.json"
Enter
Sleep 3500ms

# ---------- 2. Smoke test ----------
Type "clear && ./scripts/smoke-test.sh 2>&1 | tail -16"
Enter
Wait+Screen /All smoke tests passed/
Sleep 3s

# ---------- 3. Open Pi and dispatch ----------
Hide
Type "rm -rf /tmp/swival-demo && mkdir /tmp/swival-demo && cd /tmp/swival-demo && clear"
Enter
Sleep 500ms
Show

Type "pi --thinking off --no-session"
Enter
Sleep 4s

Type@40ms `Use swival-subagent with task: "Write 'pi-swival demo' to a file called note.txt in this directory."`
Sleep 800ms
Enter

# Fixed wait: a no-review swival dispatch typically completes in 5–15s.
# 25s gives margin for cold caches without dragging the demo too long.
Sleep 25s

# Exit Pi
Type "/exit"
Enter
Sleep 2s

# ---------- 4. Verify and show artifact ----------
Type "cat /tmp/swival-demo/note.txt"
Enter
Sleep 3s

Type `jq '{outcome: .result.outcome, rounds: .stats.review_rounds, tools: .stats.tool_calls_total, llm_time_s: .stats.total_llm_time_s}' "$(ls -td ~/.pi/agent/swival-artifacts/swival-* | head -1)/report.json"`
Enter
Sleep 5s

# Cleanup hidden
Hide
Type "rm -rf /tmp/swival-demo && clear"
Enter
Sleep 500ms
