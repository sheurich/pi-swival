# pi-swival reviewed-fix demo
#
# Render through `make -C demo quick`. demo/record.sh supplies a disposable
# HOME, a clean checkout, selected provider credentials, and the
# pi-swival extension as the only loaded resource.

Output demo/demo-quick.gif
Output demo/demo-quick.mp4

Set Shell bash
Set FontSize 14
Set Width 1280
Set Height 760
Set Theme "Dracula"
Set TypingSpeed 25ms
Set WindowBar Colorful
Set Padding 16
Set Margin 16
Set MarginFill "#0a0a14"
Set WaitTimeout 240s

Hide
Type `mkdir -p "$PI_SWIVAL_DEMO_REPO/workspace" && cd "$PI_SWIVAL_DEMO_REPO/workspace"`
Enter
Type `printf '%s\n' 'def apply_discount(total: float, percent: float) -> float:' '    return total * (1 - percent / 100)' > checkout.py`
Enter
Type `printf '%s\n' 'from checkout import apply_discount' '' 'def test_regular_discount():' '    assert apply_discount(80, 25) == 60' '' 'def test_discount_never_returns_negative():' '    assert apply_discount(80, 125) == 0' > test_checkout.py`
Enter
Type `clear`
Enter
Sleep 500ms
Show

Type "# Delegate a failing test; Swival fixes, reviews, and verifies it"
Enter
Sleep 1500ms
Type "python3 -m pytest -q"
Enter
Sleep 3s
Type "printf 'Pi '; pi --version"
Enter
Sleep 2s
Type "pi-swival-demo quick"
Enter
Sleep 4s
Type@25ms `Use swival-subagent with agent "self-review-worker", agentScope "user", and task: "Fix checkout.py so apply_discount never returns a negative total. Keep both tests unchanged and run python3 -m pytest -q before finishing." Do not call any other tool.`
Sleep 750ms
Enter
Wait+Screen /Fix reviewed and tests pass\./
Sleep 3s
Type "/quit"
Enter
Sleep 2s
Type "python3 -m pytest -q"
Enter
Sleep 3s
