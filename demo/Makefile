# Regenerate the pi-swival demo recordings.
#
# Targets:
#   make all      — render both demos
#   make quick    — render demo-quick only
#   make reviewer — render demo-reviewer only
#   make clean    — delete generated GIFs and MP4s
#
# Each tape file is a real recording driven by `vhs`. Rendering invokes a
# live `pi` session and dispatches through swival, so each render costs
# one LLM round-trip (more for the reviewer-loop demo).

VHS ?= vhs

.PHONY: all quick reviewer clean

all: quick reviewer

quick: demo-quick.gif demo-quick.mp4

reviewer: demo-reviewer.gif demo-reviewer.mp4

demo-quick.gif demo-quick.mp4: demo-quick.tape
	cd .. && $(VHS) demo/demo-quick.tape

demo-reviewer.gif demo-reviewer.mp4: demo-reviewer.tape
	cd .. && $(VHS) demo/demo-reviewer.tape

clean:
	rm -f demo-quick.gif demo-quick.mp4 demo-reviewer.gif demo-reviewer.mp4
