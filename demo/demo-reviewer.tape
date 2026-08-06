# pi-swival reviewer-loop demo
#
# Render through `make -C demo reviewer`. demo/record.sh supplies a disposable
# HOME, a clean checkout, selected provider credentials, and the
# pi-swival extension as the only loaded resource.

Output demo/demo-reviewer.gif
Output demo/demo-reviewer.mp4

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

# Enter the disposable workspace without recording its generated path.
Hide
Type `mkdir -p "$PI_SWIVAL_DEMO_REPO/workspace" && cd "$PI_SWIVAL_DEMO_REPO/workspace" && clear`
Enter
Sleep 500ms
Show

Type "# pi-swival: Swival implements, reviews, and verifies before returning"
Enter
Sleep 1500ms
Type "printf 'Pi '; pi --version"
Enter
Sleep 2s

Type "pi-swival-demo reviewer"
Enter
Sleep 4s

Type@30ms `Use swival-subagent with agent "self-review-worker", agentScope "user", and task: "Create greet.py with greet(name: str) -> str returning 'Hello, ' + name + '!'. Create test_greet.py with one pytest test asserting greet('world') == 'Hello, world!'. Run python3 -m pytest -q before finishing." Do not call any other tool.`
Sleep 1s
Enter
Wait+Screen /Reviewer complete\./
Sleep 4s
Type "/quit"
Enter
Sleep 2s
