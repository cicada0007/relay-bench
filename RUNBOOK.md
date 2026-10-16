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
| A | `node runner/run-stage.mjs --test A --model claude-sonnet-5-5 --tools relay,prime-agent,claude-code --tasks kind:long --reps 3 --cap-usd 5 --stage-cap-usd 190 --concurrency 4 --out runs/round-1` | 108 | $190 |
| B, everyday | `node runner/run-stage.mjs --test B --model claude-haiku-5-5 --tools relay,prime-agent,claude-code,hermes --tasks kind:everyday --reps 3 --cap-usd 1 --stage-cap-usd 80 --concurrency 6 --out runs/round-1` | 144 | B shares $80 |
| B, long | `node runner/run-stage.mjs --test B --model claude-haiku-5-5 --tools relay,prime-agent,claude-code,hermes --tasks kind:long --reps 1 --cap-usd 2 --stage-cap-usd 80 --concurrency 4 --out runs/round-1` | 48 | B shares $80 |
| D | `node runner/run-stage.mjs --test D --model claude-haiku-5-5 --tools relay,prime-agent,claude-code,hermes --tasks <one long task> --faults kill,network,errors --reps 2 --cap-usd 1.5 --stage-cap-usd 25 --out runs/round-1` | 24 | $25 |

Caps follow amendment 2 in PREREGISTRATION.md. The pilot spent $19.52.

Tests C (OpenAI credit only), E (learning) and G (long-context sets) have their own sections below once their runners
exist.

## Test F: Terminal-Bench 2.1

Terminal-Bench 2.1's full public set (89 tasks), Relay and Claude Code on Claude Haiku 5.5, 2 trials per task per tool,
through Harbor, the benchmark's official runner, with every task in an E2B sandbox (no Docker needed).

- **Pins.** Harbor 0.24.0 and the dataset version `terminal-bench/terminal-bench-2-1@sha256:7d7bdc1c…` (registry revision
  6; `runner/tb21-tasks.json` lists its tasks, `harbor-agents/tb21_tasks.py` rewrites it). Relay 0.6.118, Claude Code
  2.1.300 and Node 22.23.1 (the same Node for both tools) are pinned in `harbor-agents/relay_bench_agents.py`.
- **The agents.** `relay_bench_agents:Relay` installs Relay with its installer, sets every tier to the test model, and
  runs `relay -p --mode json` on the task's instruction. `relay_bench_agents:BenchClaudeCode` is Harbor's own
  `claude-code` agent unchanged (permissions bypassed in the container), with every Claude Code tier on the test model.
  Both send their model traffic through the round's meter inside the task container, as in the other tests; Harbor's
  cost and token fields come from it, and each tool's own report is kept beside them in the trial's `result.json`.
- **Caps.** Each trial stops at `--cap-usd` (the meter refuses further model requests). A trial starts only while the
  stage's spend plus every trial in flight at its cap stays within `--stage-cap-usd`.
- **Timeouts.** Each task's own agent and verifier timeouts from the dataset, the same for both tools.

Install Harbor once: `uv tool install 'harbor[e2b]==0.24.0'`. Then run, and run the same command again to resume:

```
node runner/tb21.mjs --tools relay,claude-code --trials 2 --model claude-haiku-5-5 --cap-usd 1 --stage-cap-usd 45 --concurrency 4 --out runs/round-1
node runner/tb21-analyze.mjs --out runs/round-1 --test F
```

Results land in `runs/round-1/F/`: `records.jsonl` (one line per trial), `spend.jsonl` (every attempt's metered cost,
retries included), `infra-failures.log`, and `jobs/<job>/` with Harbor's full trial directories (the tool's output,
`meter.jsonl`, the verifier's output). A development run on a few tasks uses another test name and output folder:
`node runner/tb21.mjs --test dev-F --tasks fix-git,regex-log --cap-usd 0.2 --stage-cap-usd 1.5 --out runs/dev`.

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
