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

Tests C (OpenAI credit only) and E (learning) will get their own sections below once their runners exist. Tests F and
G have theirs.

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

## Test G: two long-context sets

Two long-context benchmarks from the same-model table in Prime Agent's launch post
(primeintellect.ai/blog/prime-agent). Both have public data and a mechanical scorer, with no model acting as judge:

- **OOLONG (yahoo, 128k).** OOLONG-synth (`oolongbench/oolong-synth`, revision `f0d59eaf0feb…`), test split, the
  `yahoo` rows with a 131,072-token window. There are exactly 50 of them, so the sample of 50 is all of them. Scored
  with OOLONG's `synth_process_response` (abertsch72/oolong at `0bb7eabe…`).
- **LongBench v2.** `zai-org/LongBench-v2` (formerly THUDM), revision `2b48e494f2c7…`, `data.json` sha256 `15d61c22…`.
  50 of the 503 questions are drawn. Scored with LongBench's `extract_answer` and accuracy, uncompensated
  (THUDM/LongBench at `2e00731f…`).

These two were chosen because both are on Hugging Face at a pinned revision and both have a published deterministic
scorer. The table's other rows were not checked to the same depth. EmulatorBench is a preview benchmark. `runner/longctx-manifest.json` is committed. It lists
both samples in their drawn order: ascending ids, a Fisher-Yates shuffle with mulberry32 seeded 20261015, then the first
50. It also records each item's answer and the sha256 of its context and question. If the round shrinks (step 1 of
the shrink order), `--per-set 25` runs the first 25 of each set.

Each run uses a fresh sandbox from `relay-bench-round-1`. The item's context is written to `/home/user/work/context.txt`
and the prompt is the benchmark's own question, with one line saying where the context is. Each tool runs in its own
non-interactive mode, printing text: `relay -p`, `claude -p --dangerously-skip-permissions` and `prime-agent -p`. Every
model tier is on the test model, set as in `runner/arms.mjs`. Prime Agent reaches the meter through its endpoint
setting, as in the other tests. The tool's final printed answer is scored. Model traffic goes through the round's meter
at api.anthropic.com (`runner/sandbox-meter.mjs`), which stops a run at `--cap-usd`. A run starts only while the stage's
spend, plus every run in flight at its cap, stays within `--stage-cap-usd`.

Download the data once (465 MB; it needs `uv`, because OOLONG's parquet is read with DuckDB). Check it against the
manifest, then run. To resume, run the same command again:

```
node runner/longctx-data.mjs && node runner/longctx-data.mjs --check
node runner/longctx.mjs --tools relay,claude-code,prime-agent --per-set 50 --model claude-haiku-5-5 --cap-usd 0.5 --stage-cap-usd 25 --concurrency 4 --out runs/round-1
node runner/longctx-analyze.mjs --out runs/round-1 --test G
```

Results land in `runs/round-1/G/`:

- `records.jsonl`, one line per run
- `spend.jsonl`, every attempt's metered cost, retries included
- `infra-failures.log`
- one folder per run, with the tool's stdout and stderr, `meter.jsonl` and `record.json`

An item whose run failed twice because of our infrastructure is dropped for every tool, and the analysis lists it.

**Projected cost.** 18 development runs (3 items per set, each tool) cost $0.087 in total. The most expensive run cost
$0.016, and no run came near its cap. The mean per item per tool:

| Set | Relay | Claude Code | Prime Agent |
| --- | --- | --- | --- |
| OOLONG | $0.0021 | $0.0016 | $0.0034 |
| LongBench v2 | $0.0071 | $0.0044 | $0.0104 |

At those rates the full stage (50 per set, three tools, 300 runs) costs about $1.50. Allowing three times that for
longer LongBench items gives about $4.50, well inside $25, so the stage does not need to shrink. In development every
tool answered in 10 to 30 seconds without reading most of the context. On OOLONG every tool said the answer "cannot
be determined", because the lines carry no labels: the task expects the model to label each question itself. So all
three tools may score near 0 on that set with Haiku 5.5.

A development run uses another test name, and its output goes under `runs/dev-G/`:
`node runner/longctx.mjs --test dev-G --out runs --per-set 3 --cap-usd 0.3 --stage-cap-usd 1.9`.

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

## The gate: a new Relay against the current one

GATE.md fixes the rules (amendment 1 is gate v2); TIERS.md says which tasks a gate may use. A gate compares two released
Relay versions on the same tasks, model and limits, and exits 0 (PASS), 10 (BLOCK) or 20 (UNRESOLVED).

1. **See what it would run, free:** add `--dry-run` to the command below. Nothing starts and nothing is spent.
2. **Run it** (paid, within the caps you give it, after a founder's yes). A sequential gate with three looks over 120
   tasks; each command runs the next look's tasks, then reads that look:

   ```
   node runner/gate.mjs --run --test gate-0.6.122 --champion 0.6.121 --candidate 0.6.122-beta.3 \
     --looks 3 --plan-tasks 120 --spending obrien-fleming \
     --model claude-haiku-5-5 --tier practice --tasks kind:everyday,kind:long --reps 1 \
     --cap-usd 1 --stage-cap-usd 40 --e2b-cap-usd 20 --out runs/gate
   ```

   Run the same command again for the next look while it prints `continue`. It stops at the first PASS or BLOCK and
   then refuses to run more. Each run installs its version with Relay's own installer (`RELAY_VERSION`) and records
   what `relay --version` printed. A run that fails inside a look is resumed by the same command. With one look, leave
   out `--looks` and keep `--plan-tasks` (or let `--run` plan every chosen task).
3. **Read it again later:** the same command without `--run`. The design, the task order and every look are kept in
   `runs/gate/<test>.looks.json`; the last look's verdict in `runs/gate/<test>.gate.json`.

On the exam tier, pass `--tier exam --tasks-dir ../relay-exam/tasks --out ../relay-exam/runs/gate --plan-tasks <n>
--anchors ../relay-exam/anchors/anchors-v1.json`. The gate then runs the anchors first and then the exam's tasks,
refuses a tasks folder inside this repository, and refuses to write exam runs inside it. Every run and every look is
counted against the leak budget (`../relay-exam/exposure.jsonl`; lower it in `../relay-exam/leak-budget.json`). Lock
the exam first with `node scripts/lock-tasks.mjs --tasks-dir ../relay-exam/tasks`; an exam task that is not approved
stops a counted gate. The first `--run` pins the exam's graders for the candidate (`../relay-exam/pins/<version>.json`),
and every later look refuses runs graded by another judge. Make the anchor set once, from locked tasks:
`node scripts/anchors.mjs create --version anchors-v1 --tasks-dir ../relay-exam/tasks --sample 40`.

Several lane changes released together are judged as one candidate with `--combined lanes.json`, a file
`{ "release": "0.6.122-beta.3", "lanes": [{ "lane": "prompts", "change": "<commit>" }, ...] }`.

Check the gate's own false-accept rates, free: `node runner/gate-null.mjs --sims 20000` (several minutes).

### Signing a release into the ledger

A release that passed the gate on the exam goes in the compound ledger (GATE.md, amendment 2) once a founder signs it.
The command reads the gate again from its records and writes nothing unless that gives PASS:

```
node scripts/ledger.mjs write --test gate-0.6.122 --out ../relay-exam/runs/gate --tasks-dir ../relay-exam/tasks \
  --anchors ../relay-exam/anchors/anchors-v1.json --signed-by <your name>
node scripts/ledger.mjs verify
node scripts/ledger.mjs trend --quarter 2026-Q4
```

Then commit and push `ledger/ledger.json`. A release whose champion is not the ledger's last release needs
`--chain-start`, which the entry records.

### A new model: model watch

When Relay's catalogue lists a new model, Relay (with `RELAY_MODEL_WATCH=1`, harness D-93) does not route to it until
the exam has passed it. The exam gate runs with the new model as the candidate (the champion's release with the model
on every tier, or on `--tier`) against the champion as it is (GATE.md, amendment 3). A dry run is the default:

```
node scripts/model-watch.mjs --model anthropic/claude-sonnet-6            # the plan, the runs, the most it could cost
node scripts/model-watch.mjs --model anthropic/claude-sonnet-6 --spend-cap 60   # PAID: runs the gate's next look
```

It reads the champion and its model from the ledger's last entry (or `--champion` and `--champion-model`), the exam
from `../relay-exam` and its newest anchor set. A paid run is refused when the meter has no price for the new model:
add its list price to `PRICES` in `meter/meter.mjs` first. Run the same command for each look until the gate decides.
Then it writes the result as a small hashed file, `../relay-exam/runs/model-watch/<test>.exam.json`, and a copy in
`~/.relay/agent/model-watch/exams/` (`--relay-dir` for another machine's folder, `none` to skip), where Relay reads it:
a PASS lets routing use the model, anything else keeps it out. A model's exam never goes in the ledger.

## Growing the exam

**Not yet run.** Every command below is built and tested on recorded and made-up data only. TIERS.md says how a task is
made and why. Run from this folder, with the private exam repository checked out beside it at `../relay-exam`. The
candidates, tasks, review page, runs and hand-check sheets all stay in that repository; every script here refuses to
write them inside this one.

What it needs, in the environment (never on the command line):

- `GITHUB_TOKEN`: any token that can read public repositories (a fine-grained token with public read-only access; no
  scopes). The miner only sends GET requests. GitHub allows 30 searches a minute and 5,000 other requests an hour; the
  miner keeps to both.
- `OPENAI_API_KEY`, for drafting only: one Responses API call per task that passes its judge check. Estimate: 2,000 to
  6,000 tokens a call, about $0.01 to $0.05 on GPT-6.1 Sol ($2 input, $10 output per million), so about $5 to $20 for
  400 tasks. A candidate whose judge does not validate makes no call.
- `E2B_API_KEY`, for drafting and validating: a candidate's judge runs that repository's own tests and gates, someone
  else's code, so draft-task's judge check and validate-task on an exam or check task run them in an E2B sandbox from
  the round's image, never on this machine (`scripts/e2b-judge.mjs`). One sandbox per task, with no keys, killed at the
  end; the repository is cloned and checked out here with git only. Without the key both refuse to start;
  `--local-judge` runs the judge here, for tests with made-up repositories only.
- No Anthropic key. Mining runs on this machine.
- Every paid call is counted in `../relay-exam/drafting/spend.json` (`scripts/draft-spend.mjs`), against its own cap
  for OpenAI and for E2B. A call is reserved at the most it could cost before it is made and refused when that could
  cross its cap; then it is settled at its real cost, from the response's usage (a draft the leak check refuses
  included) or the sandbox's seconds. Set the caps once: `--openai-cap-usd` and `--e2b-cap-usd` on the first
  draft-task command. With no cap set, nothing paid runs. A draft that stops at a cap exits 3.

1. **Find candidates** (free; read-only GitHub). `--cutoff` is a placeholder: set it to the latest training cutoff among
   the models the exam will test, from each model's own page, before mining.

   ```
   node scripts/mine-tasks.mjs --cutoff 2026-07-01 --out ../relay-exam/candidates.jsonl --limit 100
   ```

   Run it again to add more; it skips pull requests already in the file. `--verbose` prints why each one was left out.
   Expect few Node candidates: most Node projects need packages from the network, which tasks may not.

2. **Draft each candidate** (paid: one OpenAI call per task that passes its judge check, and one E2B sandbox per
   candidate for the judge check).

   ```
   node scripts/draft-task.mjs --candidate <id> --candidates ../relay-exam/candidates.jsonl \
     --tasks-dir ../relay-exam/tasks --model gpt-6.1-sol --tier exam --effort low \
     --openai-cap-usd <usd> --e2b-cap-usd <usd>
   ```

   Each call asks for at most `--max-output-tokens` (6,000 by default, reasoning included) at `--effort low` or
   `medium`. A draft the leak check refuses is kept in `../relay-exam/drafting/refused/` for the reviewers.

   `--tier check` drafts a check-tier task instead. All of them, one after another:

   ```
   for id in $(node -e 'require("fs").readFileSync("../relay-exam/candidates.jsonl","utf8").split("\n").filter(Boolean).forEach(l=>console.log(JSON.parse(l).id))'); do
     [ -d ../relay-exam/tasks/$id ] || node scripts/draft-task.mjs --candidate $id \
       --candidates ../relay-exam/candidates.jsonl --tasks-dir ../relay-exam/tasks --model gpt-6.1-sol --tier exam
   done
   ```

3. **Validate** every drafted task (one E2B sandbox each, counted in the same ledger):
   `node scripts/validate-task.mjs --tasks-dir ../relay-exam/tasks <id> [<id> ...]`.
   Remove a task that fails.

4. **Review and approve** (a founder who did not draft the task). Build the review page, open it locally, and read each
   task's request beside its checks:

   ```
   node scripts/build-review-page.mjs --tasks-dir ../relay-exam/tasks     # -> ../relay-exam/review/exam-review.html
   node scripts/approve-task.mjs <id> --by <your name> --tasks-dir ../relay-exam/tasks
   ```

5. **Lock** the exam, then commit `TASKS.lock.json` and the tasks in the exam repository:
   `node scripts/lock-tasks.mjs --tasks-dir ../relay-exam/tasks`. `--check` shows what differs or is not approved.

6. **Each month, check the judges by hand** (free). Draw 1 run in 10 of a test's runs into a sheet, mark every row
   agree or disagree in a spreadsheet, then read the agreement; a judge below 90% is flagged and the command exits 1:

   ```
   node scripts/handcheck.mjs --records ../relay-exam/runs/bar/records.jsonl --tasks-dir ../relay-exam/tasks --test bar-1-haiku
   node scripts/grader-agreement.mjs ../relay-exam/runs/bar/handcheck-<date>-bar-1-haiku.csv
   ```

   Fix a flagged judge for every tool alike, then grade its runs again with `runner/rejudge.mjs`.

### The living exam, every week

**Not yet run.** One command runs the week's steps (TIERS.md, "The living exam") and stops before anything paid:

```
node scripts/living-exam.mjs --exam ../relay-exam --cutoff 2026-07-01 \
  --records ../relay-exam/runs/gate/records.jsonl --tool relay@0.6.121
```

It prints one line per step: ran, skipped (and why), or stopped. Add `--mine` to search GitHub first (needs
`GITHUB_TOKEN`; leave it out while another miner is running). When it stops at drafting, it says how many candidates
wait and the most they could cost. Drafting needs a founder's yes and `OPENAI_API_KEY` in the environment:

```
node scripts/living-exam.mjs --exam ../relay-exam --cutoff 2026-07-01 --spend-cap 2
```

Then approve each queued task on the review page (step 4 above) and run `--from approve` to lock what was approved. The
queues are in `../relay-exam/queue/`. To scan candidates without the pipeline:
`node scripts/contamination.mjs --exam ../relay-exam --cutoff 2026-07-01`. To ask the check tier its one question:
`node scripts/check-query.mjs --out ../relay-exam/runs/check --test <test> --champion <version> --candidate <version>
--tasks-dir ../relay-exam/tasks` (prints pass or fail; exit 0, 1, or 2 when refused).

## The improvement loop, every week

**Not yet run.** Built and tested on made-up data only: no model has written a change, no build has been pre-screened
and no release has been packaged from real runs. TIERS.md ("The improvement loop") says what the loop may see and what
it may never change. One command runs the week's cycle and stops before anything paid:

```
node loop/cycle.mjs --records runs/round-1/records.jsonl --records runs/round-1/F/records.jsonl \
  --harness ../prime-agent-main --harness-ref origin/feat/architecture-as-code --champion 0.6.121 --exam ../relay-exam
```

It prints one line per step (ran, skipped or stopped, and why) and writes the week's folder, `runs/loop/<2026-W43>/`:
`report.md` in plain words, one `proposals/<id>.patch` and `.json` per proposal, `cycle.json`, `spend.jsonl`,
`summary.json` (what the meta loop reads), and `release/` once a release is packaged. `--dry-run` writes nothing. Run
the same command again to resume: the week's analysis and proposals are fixed at its first run.

| Step | What it does | Paid |
| --- | --- | --- |
| meta | judges the loop's own settings by gated gain per dollar over the last 8 cycles; proposes, never applies | no |
| analyze | failure clusters from practice and public runs and the queue report in each Relay run | no |
| propose | one change per lane, checked against its lane and the invariants | the writer lanes only |
| exam | kinds of task the exam should mine more of, into `../relay-exam/queue/loop-proposals.jsonl` for a person | no |
| prescreen | each proposal's build against the champion: the dev set (practice), then the check tier's one word | yes |
| package | one combined release: `PR_BODY.md`, `release.patch`, `lanes.json`, `ledger-preview.json` | no |

The lanes, each with a fixed budget per cycle in `loop/settings.json` (estimates for the founders to confirm):

| Lane | What it may change | How | Budget |
| --- | --- | --- | --- |
| config | relay.arch `queue.stuck`, `queue.requestCheck`, attempts, a plan's size, turns per attempt | the loop's rules | $6 |
| routing | relay.arch `routing`: the tiers' models, the suitability table, the Decider's share (D-46, D-60, D-61); and the meta-harness's router: `router.table`, `router.verifierShare`, `router.minArmUsd` (D-101), from the benchmark's arm outcomes (`--arm-outcomes`) | the loop's rules | $6 |
| memory | relay.arch `memory.autoRefine`, the learning mode (D-90), from the learning ablation's two arms | the loop's rules | $6 |
| tools | the text of a `tool.*` prompt (the tools as the model sees them) | a model writes it | $6 |
| prompts and skills | the text of one prompt relay.arch lists, or a skill's SKILL.md; or a new skill taught from shared lessons (`--teaching`) | a model writes it; a taught skill is free | $8 |
| architecture | relay.arch `subAgents` and `topology` (D-91) | the loop's rules | $6 |
| exam proposals | nothing in Relay: kinds of task to mine, for a person to approve or drop | free | $0 |
| runtime | later: the E2B sandbox a task runs in (D-89); documented only | | $0 |

Before the first paid cycle:

1. **A founder approves the settings:** `node loop/meta.mjs approve --by <name>`. Every paid step refuses settings no
   person approved, or changed since.
2. **Keys in the environment:** `RELAY_BENCH_ANTHROPIC_KEY` (the pre-screen's runs, and the writer: `claude-opus-5-5`
   unless `--writer-model` says otherwise, never an OpenAI model, since OpenAI drafts the exam) and `E2B_API_KEY`.
3. **A build per proposal.** The cycle never builds, publishes or opens anything in the harness (the autopilot below
   does these steps for it, and publishes nothing). In a harness worktree at
   `v<champion>`: `git apply runs/loop/<week>/proposals/<id>.patch`, then `npm run arch`, `npm run build` and
   `npm run release:pack`; copy the Relay package to `runs/loop/<week>/packages/<id>.tgz`. A proposal with no build
   waits.
4. **Run it with a cap**, a founder's yes first: add `--spend-cap 20` (model dollars for this command; sandbox time has
   its own cap, `prescreen.e2bCapUsd`). Nothing starts whose cap would pass its lane's budget or the spend cap.

Each pre-screen runs both arms (`relay@<champion>` and `relay@pkg`, a dev test) on `prescreen.devTasks` and reads them
with the gate's own code; a build the gate's read blocks, whose interval is all below zero, or that costs or takes more
than the gate allows, is dropped. Then it runs the check tier and asks `scripts/check-query.mjs` once: every run and the
answer are counted against the leak budget, and the cycle asks at most `prescreen.maxSelectionQueries` times. The
package's `PR_BODY.md` says how to gate the release on the exam (`--combined lanes.json`) and which ledger entry it would
make; `scripts/ledger.mjs write` still writes it only after that gate stops with PASS and a founder signs.

The meta loop: `node loop/meta.mjs judge` prints each lane's spend, gated gain and gain per dollar, and its proposals
(also in `runs/loop/<week>/meta/`). A person applies one with `node loop/meta.mjs approve --by <name> --proposal
runs/loop/<week>/meta/<id>.json`.

### The autopilot: the week carried to a pull request

**Not yet run on paid steps** (the exam has no approved tasks yet). AUTOPILOT.md has the rules. One command runs the
cycle above, builds every proposal's Relay in a harness worktree (step 3, automated), pre-screens the builds, builds
and checks the packaged release at origin/main, gates it on the exam as a local build (GATE.md, amendment 4), and on
PASS writes the ledger entry and opens one pull request in the harness. Merging it is the one step for a person:

```
node loop/autopilot.mjs --spend-cap 20 --signed-by <your name> --keychain relay-openai
```

Without `--spend-cap` it runs nothing and prints the most the week could cost. With fewer than 20 approved, locked
exam tasks it runs the cycle's free steps and stops with one sentence. Approve the drafted exam tasks in one command,
at a terminal: `node scripts/approve-many.mjs --by <your name> --tasks-dir ../relay-exam/tasks --except id1,id2`.
After a merge, `node loop/autopilot.mjs --after-merge <pr>` records the release that holds it as the next champion
(the weekly run also checks by itself). `--install-schedule weekly --spend-cap 20 --signed-by <your name>` installs
the weekly launchd job, with no key in it.

### Taught skills

**Not yet run**, like the loop. Lessons people chose to share (harness D-94) are graduated into skill candidates, which
reach Relay only through the loop's prompts and skills lane and the gate (TEACHING.md):

```
node teaching/graduate.mjs <shared lesson files or folders> --out runs/teaching
node loop/cycle.mjs --records ... --harness ../prime-agent-main --champion 0.6.121 --teaching runs/teaching
```

The first prints the rule (at least 5 machines and 25 passing uses per group of near-duplicates), the candidates and
what it skipped; `--json` prints the same as numbers. The second adds each candidate as a free proposal that adds one
new SKILL.md, checked and pre-screened like the rest.

### The router's starting table

**Not yet run**, like the loop. With `--arm-outcomes` (off unless given), the routing lane reads the benchmark's arm
outcomes, the file the weekly scoreboard writes for the harness's router (`results/arm-outcomes.jsonl`, "The router's
evidence" below), and proposes a change to one row of relay.arch's `router.table`, free:

```
node loop/cycle.mjs --records ... --harness ../prime-agent-main --champion 0.6.121 --arm-outcomes results/arm-outcomes.jsonl
node loop/autopilot.mjs --spend-cap 20 --signed-by <your name> --arm-outcomes results/arm-outcomes.jsonl
```

- **The rule.** Each benchmark run is counted on the first row of the starting table its kind and difficulty match, as
  the harness reads the table. On a row's runs, the set of arms with the most proven results per dollar (runs where an
  attempt passed the benchmark's hidden tests and the picker kept it, over what every attempt spent) becomes that row's
  proposal when it gave more per dollar than the row's own arms. Both need `routing.minSamples` runs (5). A set proven
  more than 5 points less often than the row's own (the gate's non-inferiority margin) is not proposed, and the cycle's
  notes say so, as they say why every other row proposed nothing. The new row keeps, for an attempt of another harness,
  the arm that takes its place when that harness cannot be used here.
- **One a cycle.** The routing lane keeps one proposal a cycle, the one with the most runs behind it; the next waits.
  `router.verifierShare` and `router.minArmUsd` are the lane's to change too; no rule proposes them yet.
- **Judged with the meta-harness on.** The router acts only while Relay's meta-harness is on (`RELAY_META=1`), so the
  pre-screen and the gate run every Relay arm with it on, the champion's and the candidate's alike (`--relay-meta`,
  GATE.md amendment 5); the package's `PR_BODY.md` and the gate command say so.
- **Round 1's evidence proposes nothing:** on Terminal-Bench 2.1 one Relay attempt gave the most proven results per
  dollar on medium tasks, the starting table's own arms; on hard tasks it gave more per dollar than Relay and Claude
  Code together but 13 points less often, past the margin.

## The bar: five tools on the exam

**Not yet run.** Nothing below has been run: no sandbox, no model call. The Codex arm, the OpenAI meter and the bar's
export are built and tested on fakes and hand-written fixtures only.

Relay, Claude Code, Prime Agent and Hermes run on Claude Haiku 5.5 over the whole exam. Codex runs on an OpenAI model,
so it is compared with Relay on that same model: GPT-6 Luna, which has the same list prices as Haiku 5.5 ($0.10 input,
$0.50 output per million). Then a spot check runs 100 exam tasks on Claude Sonnet 5.5. Every tool is in its documented
unattended mode (`runner/arms.mjs`), with the same tasks, time limit, spend cap per run, sandbox image and meter. Relay is
the released version under test, installed by its own installer (`relay@0.6.121`; use the champion of the day).

The numbers follow PREREGISTRATION.md's statistics. The task is the unit. Each comparison is Relay minus the other tool
over the tasks both ran, with a 95% bootstrap interval over tasks (10,000 resamples, seed 20261015). The published
export carries numbers only: no words for the result, no colours, and no exam task names.

Before the first run:

1. **The exam is ready:** its tasks are approved and locked (see "Growing the exam"). A counted stage refuses anything
   else.
2. **Keys in the environment:** `RELAY_BENCH_ANTHROPIC_KEY`, `RELAY_BENCH_OPENAI_KEY` and `E2B_API_KEY`. Each run gets
   only its model's key: Codex and Relay on GPT-6 Luna get the OpenAI key as `OPENAI_API_KEY` and `CODEX_API_KEY`.
3. **The image is rebuilt with Codex 0.163.0** (`node sandbox/template.mjs`; Codex was pinned after round 1). This
   rebuild also refreshes the other tools' layers at their pinned versions.
4. **Smoke runs** (dev, about $0.10 in all). Check that each tool finishes. For Codex, also check that `meter.jsonl` has
   `"transport":"websocket"` lines with a `costUsd`: Codex talks to the Responses API over a WebSocket by default.

   ```
   node runner/run-one.mjs --task smoke-add --tasks-dir dev-tasks --tool codex --model gpt-6-luna --cap-usd 0.2 --test dev --out runs/dev
   node runner/run-one.mjs --task smoke-add --tasks-dir dev-tasks --tool relay@0.6.121 --model gpt-6-luna --cap-usd 0.2 --test dev --out runs/dev
   ```

5. **A pilot on 3 exam tasks** for every tool, to measure the real cost per run. Its runs go beside the exam, like
   every exam run:

   ```
   node runner/run-stage.mjs --test dev-bar-haiku --model claude-haiku-5-5 --tools relay@0.6.121,claude-code,prime-agent,hermes \
     --tasks tier:exam --tasks-dir ../relay-exam/tasks --sample 3 --reps 1 --cap-usd 1 --stage-cap-usd 12 --e2b-cap-usd 5 --out ../relay-exam/runs/dev-bar
   node runner/run-stage.mjs --test dev-bar-openai --model gpt-6-luna --tools relay@0.6.121,codex \
     --tasks tier:exam --tasks-dir ../relay-exam/tasks --sample 3 --reps 1 --cap-usd 1 --stage-cap-usd 6 --e2b-cap-usd 5 --out ../relay-exam/runs/dev-bar
   ```

The three stages. Each one resumes when run again, and each one stops at its own cap. `--e2b-cap-usd` counts every
run in `../relay-exam/runs/bar`.

| Stage | Command | Runs | Cap |
| --- | --- | --- | --- |
| Haiku 5.5, four tools | `node runner/run-stage.mjs --test bar-1-haiku --model claude-haiku-5-5 --tools relay@0.6.121,claude-code,prime-agent,hermes --tasks tier:exam --tasks-dir ../relay-exam/tasks --reps 1 --cap-usd 1 --stage-cap-usd 250 --e2b-cap-usd 120 --concurrency 6 --out ../relay-exam/runs/bar` | 4 per task, about 1,600 | $250 |
| GPT-6 Luna, Codex and Relay | `node runner/run-stage.mjs --test bar-1-openai --model gpt-6-luna --tools relay@0.6.121,codex --tasks tier:exam --tasks-dir ../relay-exam/tasks --reps 1 --cap-usd 1 --stage-cap-usd 125 --e2b-cap-usd 120 --concurrency 6 --out ../relay-exam/runs/bar` | 2 per task, about 800 | $125 |
| Sonnet 5.5 spot check, 100 tasks | `node runner/run-stage.mjs --test bar-1-sonnet --model claude-sonnet-5-5 --tools relay@0.6.121,claude-code,prime-agent --tasks tier:exam --sample 100 --tasks-dir ../relay-exam/tasks --reps 1 --cap-usd 2 --stage-cap-usd 300 --e2b-cap-usd 120 --concurrency 4 --out ../relay-exam/runs/bar` | 300 | $300 |

Every cap is an estimate for the founders to confirm, and so is the total: $675 for models and $120 for sandboxes. The
estimate assumes round 1's cost per everyday change on Haiku 5.5 ($0.03 to $0.04 a run) rising to about $0.15 on real
repositories. Sonnet 5.5 costs 20 times Haiku 5.5's price per token. The pilot above replaces the estimate. To compare
Codex on GPT-6.1 Sol instead (test C's model in PREREGISTRATION.md), change `--model gpt-6.1-sol` and raise that
stage's caps about 20 times.

Read each stage, then write the comparison for the website:

```
node runner/analyze.mjs --out ../relay-exam/runs/bar --test bar-1-haiku --relay relay@0.6.121
node runner/analyze.mjs --out ../relay-exam/runs/bar --test bar-1-openai --relay relay@0.6.121
node runner/analyze.mjs --out ../relay-exam/runs/bar --test bar-1-sonnet --relay relay@0.6.121
node scripts/export-results.mjs --bar --out ../relay-exam/runs/bar --to results/bar-1.json --relay relay@0.6.121
```

`results/bar-1.json` (`scripts/export-bar.mjs`) has, for each stage and tool:

- the tasks and runs, requirements met, all runs pass, said done but failed, cost, cost per solved task and median
  minutes;
- for each other tool, Relay minus that tool, with its interval.

It has no result words, no task names and no per-task scores. A stage not run yet is marked `"not run yet"`. A stage
cut short is marked `"in progress"`, with a count of the runs it did not make. Then run the monthly hand check on these
runs ("Growing the exam", step 6).

## The scoreboard, every week

**Not yet run on SWE-bench or the exam.** The SWE-bench runners, the Codex agent and the picker over any arms are built
and tested on made-up records only; no SWE-bench trial and no new picker call has been made. The one live number on the
scoreboard today is Terminal-Bench 2.1 from round 1 (test F), with the meta-harness scored from the picker answers round
1's exam already gave, at no new cost.

`results/scoreboard.json` (`scripts/scoreboard.mjs`) says, for each benchmark and model, each tool's score with its 95%
interval, cost, cost per solved task and median time, and the same for **Relay meta-harness**: the picker
(`meta/pick-groups.mjs`) choosing among the attempts every tool made on the same task, blind to grades and to which tool
made which attempt. Its cost is every attempt plus the picker. Then, for each run, the meta-harness minus each tool and
Relay minus each other tool, in points with their intervals. Numbers only: no result words, no colours, and no exam task
names.

### The benchmarks

Found in Harbor's registry on 24 Oct 2026 with Harbor 0.24.0 (`harbor version list <org/name>`, free):

| Benchmark | Dataset, pinned by digest | Tasks | Task list |
| --- | --- | ---: | --- |
| Terminal-Bench 2.1 | `terminal-bench/terminal-bench-2-1@sha256:7d7bdc1c…` (revision 6) | 89 | `runner/tb21-tasks.json` |
| SWE-bench Verified | `swe-bench/swe-bench-verified@sha256:b934b0cc…` (revision 2) | 500 | `runner/swebench-verified-tasks.json` |
| SWE-bench Pro | `scale-ai/swe-bench-pro@sha256:88411d32…` (revision 2) | 731 | `runner/swebench-pro-tasks.json` |

SWE-bench Verified is the `swe-bench` organisation's own package and SWE-bench Pro is `scale-ai`'s, the benchmark's
authors; the registry also holds third-party copies (`nanoswe/swe-bench-verified`, `cais/swebenchpro`), which are not
used. **Terminal-Bench 4.0 is not in the registry as an official release:** the `terminal-bench` organisation has
`terminal-bench`, `terminal-bench-2` and `terminal-bench-2-1` only, and the 4.0 copies belong to a personal account
(`ryanmarten/terminal-bench-4-no-prebuild`, tagged 4.0.0, and `ryanmarten/tb4-preview`). Rewrite a task list after a
new pin with `~/.local/share/uv/tools/harbor/bin/python -I harbor-agents/dataset_tasks.py <org/name> sha256:<digest>`.

### The tools

`harbor-agents/relay_bench_agents.py` has three Harbor agents, all on the round's meter and the same Node:
`Relay` (Relay 0.6.118 unless `--relay-version` says otherwise, on an Anthropic or an OpenAI model),
`BenchClaudeCode` (Harbor's own Claude Code agent, 2.1.300) and `BenchCodex` (Harbor's own Codex agent, 0.163.0, the
version `sandbox/template.mjs` pins; Harbor 0.24.0 has it built in). Claude Code runs Anthropic models and Codex OpenAI
models, so each benchmark has two runs: Relay and Claude Code on Claude Haiku 5.5, and Relay and Codex on GPT-6 Luna,
which has Haiku 5.5's list prices. Use the Relay release of the day for `--relay-version` (the bar uses 0.6.121).

### Before the first run

1. **Harbor 0.24.0:** `uv tool install 'harbor[e2b]==0.24.0'`.
2. **Keys in the environment, never on the command line:** `RELAY_BENCH_ANTHROPIC_KEY`, `RELAY_BENCH_OPENAI_KEY` and
   `E2B_API_KEY`. Each trial gets only its model's key.
3. **Smoke trials** (dev, about $1 in all), one task each. Codex must show the meter its traffic before any counted
   trial, and harbor-bench checks it by itself: a stage with Codex whose test does not start with `dev-` refuses to
   start until a dev trial of the pinned Codex (0.163.0) left a `meter.jsonl` with lines that have
   `"transport":"websocket"` and a `costUsd`, in `runs/dev`, the stage's `--out` folder or a folder named with
   `--codex-smoke`. The check reads files and is free; `--dry-run` prints what it found. A person runs the smoke:

   ```
   node runner/harbor-bench.mjs --bench swebench-verified --test dev-swebench --tasks astropy__astropy-12907 --tools relay,claude-code --model claude-haiku-5-5 --relay-version 0.6.121 --cap-usd 0.5 --stage-cap-usd 2 --e2b-cap-usd 1 --out runs/dev
   node runner/harbor-bench.mjs --bench swebench-verified --test dev-swebench-openai --tasks astropy__astropy-12907 --tools relay,codex --model gpt-6-luna --relay-version 0.6.121 --cap-usd 0.5 --stage-cap-usd 2 --e2b-cap-usd 1 --out runs/dev
   rg -c '"transport":"websocket"' runs/dev/dev-swebench-openai/jobs/*/*/agent/meter.jsonl
   ```

4. **A pilot on 10 tasks** of each benchmark, to measure the real cost per trial (add `--sample 10 --test pilot-<bench>`
   to the commands below, with a stage cap of $15). The caps below are estimates for the founders to confirm; the pilot
   replaces them.

### The runs

Add `--dry-run` to any command to see the plan and the most it could cost, free. Each stage resumes when run again and
stops at its own caps; records land in `runs/scoreboard/<bench>-<model>/`.

- **Model spend:** `--cap-usd` a trial (the meter refuses requests past it) and `--stage-cap-usd` the stage.
- **Sandbox time**, which E2B bills apart: `--e2b-trial-cap-usd` a trial ($0.25 unless given, about 90 minutes of a
  2 vCPU, 4 GiB sandbox; fewer minutes for a task that asks for a larger one, `runner/task-meta.json`) and
  `--e2b-cap-usd` the stage, required for a paid run. Two minutes before a trial's cap Harbor is interrupted, which
  stops the sandbox and writes the trial's result in that time; the trial is recorded as stopped at its sandbox cap,
  the tool's limit once the tool had started, as a spend cap is. A trial starts only while the stage's sandbox spend plus every trial in flight at its cap
  fits `--e2b-cap-usd`, and a retry only while it still fits. If Harbor does not stop within two minutes of the
  interrupt, it is killed and the stage stops at once, saying the sandbox may still be running: check E2B's dashboard.
- Each record and `spend.jsonl` line holds the trial's sandbox seconds and dollars (`sandbox`, `sandboxUsd`) beside
  its model cost, at E2B's published price (`scripts/draft-spend.mjs`), from the Harbor job's start to its exit, so it
  never counts less than E2B bills.

| Run | Command | Trials | Cap |
| --- | --- | ---: | ---: |
| SWE-bench Verified, Haiku 5.5 | `node runner/harbor-bench.mjs --bench swebench-verified --tools relay,claude-code --model claude-haiku-5-5 --relay-version 0.6.121 --trials 1 --cap-usd 1 --stage-cap-usd 150 --e2b-cap-usd 60 --concurrency 4 --out runs/scoreboard` | 1,000 | $150 + $60 |
| SWE-bench Verified, GPT-6 Luna | `node runner/harbor-bench.mjs --bench swebench-verified --tools relay,codex --model gpt-6-luna --relay-version 0.6.121 --trials 1 --cap-usd 1 --stage-cap-usd 150 --e2b-cap-usd 60 --concurrency 4 --out runs/scoreboard` | 1,000 | $150 + $60 |
| SWE-bench Pro, Haiku 5.5 | `node runner/harbor-bench.mjs --bench swebench-pro --tools relay,claude-code --model claude-haiku-5-5 --relay-version 0.6.121 --trials 1 --cap-usd 1 --stage-cap-usd 220 --e2b-cap-usd 90 --concurrency 4 --out runs/scoreboard` | 1,462 | $220 + $90 |
| SWE-bench Pro, GPT-6 Luna | `node runner/harbor-bench.mjs --bench swebench-pro --tools relay,codex --model gpt-6-luna --relay-version 0.6.121 --trials 1 --cap-usd 1 --stage-cap-usd 220 --e2b-cap-usd 90 --concurrency 4 --out runs/scoreboard` | 1,462 | $220 + $90 |
| Terminal-Bench 2.1, GPT-6 Luna | `node runner/harbor-bench.mjs --bench terminal-bench-2-1 --tools relay,codex --model gpt-6-luna --relay-version 0.6.121 --trials 2 --cap-usd 1 --stage-cap-usd 45 --e2b-cap-usd 20 --concurrency 4 --out runs/scoreboard` | 356 | $45 + $20 |

Test F's mean cost per trial on Haiku 5.5 was $0.02 (Relay) and $0.04 (Claude Code); a SWE-bench trial reads a real
repository and is estimated at about $0.10. Test F's trials held their sandboxes about 400 seconds each, $0.02 at E2B's
price, the longest about an hour; the sandbox caps above assume a SWE-bench trial takes up to three times that, and are
estimates for the founders to confirm, as the model caps are. A run cut short (`--sample n` for a fixed draw of n tasks) is marked on the scoreboard with the trials it
did not make.

### The meta-harness's picks

After a run, the picker chooses on every group of attempts (one per tool, same task and trial number). Its calls are
OpenAI calls with their own cap, after a founder's yes; answers are kept beside the run and reused, so a second command
costs nothing more:

```
node meta/pick-groups.mjs --records runs/scoreboard/swebench-verified-claude-haiku-5-5/records.jsonl --model claude-haiku-5-5 --dry-run
node meta/pick-groups.mjs --records runs/scoreboard/swebench-verified-claude-haiku-5-5/records.jsonl --model claude-haiku-5-5 --keychain relay-openai --openai-cap-usd 20
```

The dry run prints the groups and the most the calls could cost. `--ask split` asks only about groups the grader split
(where the choice changes the score); the scoreboard then estimates the picker's cost on the other groups from the asked
calls' mean and shows it apart. On the exam, give the tasks folder; each call is counted against the leak budget first:

```
node meta/pick-groups.mjs --records ../relay-exam/runs/bar/records.jsonl --test bar-1-haiku --model claude-haiku-5-5 --tasks-dir ../relay-exam/tasks --dry-run
```

Round 1's Terminal-Bench pairs need no new call: `--records runs/round-1/F/records.jsonl --model claude-haiku-5-5
--arms claude-code,relay --ask split --reuse runs/meta/pick-exam-gpt-6.1-sol-medium.jsonl` reuses the exam's answers.

### The scoreboard

```
node scripts/scoreboard.mjs --dry-run      # prints every run's entries; writes nothing
node scripts/scoreboard.mjs                # writes results/scoreboard.json for this ISO week
node scripts/scoreboard.mjs --install-schedule weekly    # every Monday at 07:00 (macOS launchd; prints a crontab line)
```

It reads `runs/round-1/F/`, every stage under `runs/scoreboard/`, and the bar's stages in `../relay-exam/runs/bar/`. It
never runs a trial or asks the picker, so the weekly job costs nothing; the week's numbers change when a person runs a
stage or the picker with a cap. Each entry's `sandboxUsd` is its trials' sandbox time at E2B's price, apart from the
model's `costUsd`: as the runner recorded it, or for a trial that recorded none (round 1's), estimated from its start
and end (`sandboxEstimatedTrials`). Each week's headline numbers are added to the file's `history`, and a second build in the
same week replaces that week's lines. A group the picker has not answered yet is counted (`groupsNotDecided`), never
guessed, and its run stays `"in progress"`.

To publish, one command opens a pull request in the public repository Relay-harness/relay for a person to merge:

```
node scripts/publish-scoreboard.mjs --dry-run      # everything but the push and the pull request
node scripts/publish-scoreboard.mjs                # or: node scripts/scoreboard.mjs --publish
```

It works in a detached worktree of `../relay-public` (the checkout itself is never changed), copies the file to
`benchmarks/scoreboard/scoreboard.json`, renders the page with that repository's `render.mjs`, and runs its
`--check` (the page is the file's rendering, and neither holds a word for a result); a failed check pushes nothing.
Then it pushes the branch `scoreboard/<week>` and opens one pull request with `gh --repo Relay-harness/relay`; a second
run in the same week adds a commit to the open one, and a file the page already shows publishes nothing. The weekly
job publishes only when installed with `--publish` (`node scripts/scoreboard.mjs --install-schedule weekly --publish`),
and needs `gh` signed in for the person whose job it is. The page does not yet show the sandbox cost column; its
`render.mjs` reads only the fields it knows.

### The router's evidence

Every build of the scoreboard also writes `results/arm-outcomes.jsonl` (`scripts/arm-outcomes.mjs`), free: the same
public trials and picker answers as arm outcomes for the harness's router (relay-harness D-101), in the format its
`docs/queue.md` documents ("The router"). A person imports them on their own machine:

```
relay router learn --import results/arm-outcomes.jsonl
node scripts/arm-outcomes.mjs --check results/arm-outcomes.jsonl     # each line against the import format, free
```

- **A run is one task worked once**, its lines sharing `projectKey` (`bench/<benchmark>`), `taskId` (the task, the
  trial number and the arms) and `at` (its first attempt's start). Each picker group is a run of every tool's attempt
  (`picked` is the picker's choice; where every attempt had the same grade and the picker was not asked, the attempt it
  would have been shown first, an order fixed by the group, never by the tool). Each of Relay's trials is also a
  one-arm run, as the starting table's one-arm rows start it (picked when it passed). Claude Code and Codex appear only
  beside Relay, so an import never makes another harness usable by solving tasks alone.
- **`verified` is the benchmark's grade** (the hidden tests passed), `costUsd` the arm's model spend, `arm.strategy`
  `direct`, `arm.where` `e2b`. **Kind and difficulty** come from the task's own metadata (`runner/task-meta.json`, from
  each task's task.toml at its pinned digest: `node scripts/arm-outcomes.mjs --write-task-meta`): Terminal-Bench gives a
  difficulty and a category (debugging is a bug fix; the others are other tasks). Without it, SWE-bench Verified's
  tasks are bug fixes and SWE-bench Pro's other tasks, and the difficulty is medium.
- **Left out and counted:** tasks dropped for every tool, groups not picked yet, groups where an attempt kept no record
  of its actions, and the sealed exam (never named in a public file). One line outside the import format writes nothing.
