# Round 1 runbook

How round 1 is run, in order, with the exact commands. PREREGISTRATION.md decides what is measured and how it is
scored; this file only says how to run it. Every command runs from this folder with Node 22 first on PATH, and with
`RELAY_BENCH_ANTHROPIC_KEY` and `E2B_API_KEY` in the environment (never on the command line).

```
export PATH=~/.nvm/versions/node/v22.23.1/bin:$PATH
```

## Before the first counted run

1. **Tasks built and validated.** `node scripts/validate-task.mjs <id>` prints ok for every task in `tasks/`.
2. **Tasks reviewed.** Every part of every long task is marked clear and fair on the private review page
   (`node scripts/build-review-page.mjs`, then publish `review/task-review.html` privately). A part marked unclear or
   unfair is fixed in the request or the judge, for every tool alike, and marked again.
3. **Tasks locked.** `node scripts/lock-tasks.mjs`, then commit and push `TASKS.lock.json`. Counted tests refuse to run
   when a task differs from the lock; `node scripts/lock-tasks.mjs --check` shows what differs.
4. **Versions frozen.** `sandbox/template.mjs` pins every tool. Build the image once (`node sandbox/template.mjs`),
   then run the smoke task for every tool:
   `node runner/run-one.mjs --task smoke-add --tasks-dir dev-tasks --tool <tool> --model claude-haiku-5-5 --cap-usd 0.5 --test dev --out runs/dev`
5. **Amendments pushed.** Every change to PREREGISTRATION.md is committed and pushed before the runs it affects.

## The tests

Each stage resumes: run the same command again and it skips runs already in `runs/round-1/records.jsonl`. A stage
never spends past `--stage-cap-usd`: it waits while runs in flight could each still reach their cap, and stops only
when one more run alone could pass it. Read a test's results with `node runner/analyze.mjs --out runs/round-1 --test <test>`.

| Test | Command | Runs | Cap |
| --- | --- | --- | --- |
| A | `node runner/run-stage.mjs --test A --model claude-sonnet-5-5 --tools relay,prime-agent,claude-code --tasks kind:long --reps 3 --cap-usd 5 --stage-cap-usd 170 --concurrency 4 --out runs/round-1` | 108 | $170 |
| B | `node runner/run-stage.mjs --test B --model claude-haiku-5-5 --tools relay,prime-agent,claude-code,hermes --tasks kind:long,kind:everyday --reps 3 --cap-usd 2 --stage-cap-usd 60 --concurrency 6 --out runs/round-1` | 288 | $60 |
| D | `node runner/run-stage.mjs --test D --model claude-haiku-5-5 --tools relay,prime-agent,claude-code,hermes --tasks <2 long tasks> --faults kill,network,errors --reps 2 --cap-usd 2 --stage-cap-usd 20 --out runs/round-1` | 48 | $20 |

Tests C (OpenAI credit only), E (learning), F (Terminal-Bench 2.1) and G (long-context sets) have their own sections
below once their runners exist.

## Test D's faults

Every tool in test D runs inside the same restart loop (`sandbox/restart-loop.sh`): when it stops without succeeding,
the loop runs the tool's own documented resume command (`runner/arms.mjs`, `resume`), up to 3 times, with the same
message for every tool. The faults start 120 seconds after the run's first model request:

- **kill:** the tool's process group is killed once (`SIGKILL`), as root.
- **network:** for 10 minutes the meter drops every model request's connection.
- **errors:** for 10 minutes the meter answers every model request `529 overloaded_error`.

## What each run keeps

`runs/round-1/<run-id>/`: the tool's stdout and stderr, every metered request (`meter.jsonl`: model, thinking, effort,
tokens, cost; never prompts or keys), the patch, the exact tree the judge graded (`result.tgz`), Relay's queue state,
and `record.json`. A judge fixed later re-grades every run of that task in the test alike:
`node runner/rejudge.mjs --out runs/round-1 --test <test> --task <id> --reason "<why>"`.
