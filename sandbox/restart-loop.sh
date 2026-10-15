#!/bin/sh
# Test D's restart loop (PREREGISTRATION.md: "tools without a supervisor get a restart loop that runs the tool's own
# documented resume command, as a careful person would set up"). Every tool in test D runs inside it, the same way:
# when the tool stops without succeeding, the loop runs its resume command, up to 3 times. The tool runs in its own
# process group, whose id is written to the file given, so the fault injector kills exactly the tool and not this loop.
#
#   sh restart-loop.sh '<first command>' '<resume command>' /home/user/tool.pgid
first="$1"
resume="$2"
pgid_file="$3"
command="$first"
restarts=0
while :; do
	setsid sh -c "$command" &
	pid=$!
	echo "$pid" >"$pgid_file"
	wait "$pid"
	code=$?
	[ "$code" -eq 0 ] && exit 0
	[ "$restarts" -ge 3 ] && exit "$code"
	restarts=$((restarts + 1))
	echo "restart-loop: restart $restarts after exit $code" >&2
	command="$resume"
done
