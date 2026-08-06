# Regenerate the pi-swival demo recordings.
#
# Targets:
#   make all      - render both demos
#   make quick    - render demo-quick only
#   make reviewer - render demo-reviewer only
#   make check    - validate tapes and the isolated recording harness
#   make clean    - delete generated GIFs and MP4s
#
# record.sh verifies that the installed Pi matches npm's latest release, then
# runs VHS with a disposable HOME and explicit Pi and Swival routes.

VHS ?= vhs
RECORD ?= demo/record.sh

.PHONY: all quick reviewer check clean

all: quick reviewer

quick: demo-quick.gif demo-quick.mp4

reviewer: demo-reviewer.gif demo-reviewer.mp4

check:
	shellcheck record.sh record.test.sh
	./record.test.sh
	$(VHS) validate demo-quick.tape demo-reviewer.tape

demo-quick.gif demo-quick.mp4: demo-quick.tape record.sh
	cd .. && VHS="$(VHS)" $(RECORD) demo/demo-quick.tape

demo-reviewer.gif demo-reviewer.mp4: demo-reviewer.tape record.sh
	cd .. && VHS="$(VHS)" $(RECORD) demo/demo-reviewer.tape

clean:
	rm -f demo-quick.gif demo-quick.mp4 demo-reviewer.gif demo-reviewer.mp4
