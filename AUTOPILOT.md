# The autopilot: Relay upgrades itself every week

The autopilot (`loop/autopilot.mjs`) carries one week of the improvement loop all the way to a pull request in the
harness. It studies Relay's runs, proposes changes, builds them, measures them, and gates the release on the exam. When
the gate passes, it opens one pull request. **The founder's click on Merge is the one human step per release.** The
autopilot never merges, releases, publishes or signs anything on its own.

```
node loop/autopilot.mjs --spend-cap 20 --signed-by <your name> --keychain relay-openai
```

Each run prints one line per step (ran, skipped, stopped or failed, and why) and writes a plain-words report to
`runs/loop/<week>/autopilot/report.md`. The report says what Relay learned about itself, what it proposed, what it
tested, what it cost, and whether a pull request is waiting.

## The rules

1. **No cap, no spending.** Without `--spend-cap` nothing runs at all. The command prints the most the week could cost,
   then exits 3.
2. **One pull request at a time.** While the autopilot's last pull request waits for a person, the week stops before
   anything paid. It also stops when that pull request is merged but no release holds it yet. Each cycle is measured
   against the release people have, and that release must hold the change before it.
3. **The exam decides.** A pull request opens only after the gate on the exam stops with PASS (GATE.md). The gate
   needs at least 20 approved, locked exam tasks and an anchor set. If the exam has fewer, the cycle's free steps run
   and the week stops with one plain sentence.
4. **The ledger is written on PASS only,** by `scripts/ledger.mjs write`. That script reads the gate again from its
   records and refuses anything else.
5. **What the gate judges is what the pull request holds.** The candidate is a local build named
   `<x.y.z>-loop.<year>w<week>`, for example `0.6.122-loop.2026w44`. It is packed by Relay's own release script from
   the pull request's head commit: origin/main with `release.patch` applied, after `npm run arch` and `npm run check`
   pass. The package is a local tarball that is never published. Every candidate run installs that exact tarball, and
   the gate checks its SHA-256 run by run (GATE.md, amendment 4).
6. **Keys never touch disk.** The model key comes from the Keychain item named by `--keychain`, at run time, into the
   autopilot's own environment only. `E2B_API_KEY` comes from the environment (`~/.zshenv`). Builds run with no keys
   and a scratch HOME. The weekly schedule holds no key.
7. **The founder's checkouts are read, never changed.** The autopilot runs `git fetch`, reads with `git show`, and
   builds in a separate worktree (`git worktree add` under `--work`). Its `node_modules` are links into the checkout,
   and those links are removed before the worktree is. The release's commit is kept under a hidden ref
   (`refs/relay-autopilot/<week>`) until it is pushed as `loop/<week>`.
8. **Never released by the autopilot.** It does not cut releases, bump versions, run `scripts/release.mjs` or publish
   anything. A release that holds a merged change is cut the way releases are cut today. The next weekly run reads that
   release and makes it the champion.

## The steps, and where each one stops

| Step | What it does | Paid | Stops when |
| --- | --- | --- | --- |
| money | checks for `--spend-cap` | no | no cap was given: prints the most the week could cost (exit 3) |
| pull request | reads its earlier pull requests with `gh`, and records the release that holds a merged one | no | one is open, or merged but in no release yet (exit 4) |
| harness | fixes origin/main for the week, names the champion and this week's build version | no | origin/main cannot be read |
| ready | checks the exam (20 approved, locked tasks, an anchor set), the loop's approved settings, `--signed-by`, the keys and the disk (3 GB free) | no | anything missing: runs the free cycle steps, then prints one sentence (exit 4) |
| cycle | `loop/cycle.mjs`: meta, analyze, propose, exam | the writer lanes only | the cycle stops |
| build | each proposal in a harness worktree: `git apply`, `npm run arch`, `npm run build`, `npm run release:pack` | no | (a failed build is reported and its proposal waits) |
| prescreen | `loop/cycle.mjs` again: each build against the champion on the dev set, then the check tier, then the package | yes | no proposal passed (exit 0, nothing to gate) |
| release | the package's `release.patch` at origin/main: `npm run arch`, `npm run check`, a commit, `npm run build`, `npm run release:pack` | no | the patch does not apply or a check fails (exit 1) |
| gate | `runner/gate.mjs --run` on the exam, look by look, `--combined` when two lanes or more | yes | BLOCK (exit 10), UNRESOLVED (exit 20), or the cap runs out between looks |
| ledger | `scripts/ledger.mjs write --signed-by <name>`, with `--follows` or `--chain-start` when needed | no | the ledger refuses (exit 1) |
| pull request | pushes `loop/<week>` and opens a pull request in cicada0007/relay-harness with the label `no-linear` | no | (exit 0) |

The pull request's body is the package's `PR_BODY.md`, then the gate's verdict and its numbers, the build's commit
and SHA-256, the week's spend, the ledger entry, how to roll back, and the exact commands to reproduce. It holds
numbers only.

Run the same command again to resume. The week's analysis and proposals are fixed at its first run. Builds, finished
pre-screens, the release build, the gate's looks, the ledger entry and the pull request are each done once.

## Money

`--spend-cap` is the most one run of the command spends on models: the writer lanes, the pre-screens and the gate
together. Sandbox time has its own caps: one `prescreen.e2bCapUsd` ($10) for the week's dev runs, one for its
check-tier runs, and $20 per gate look.

- **The most a week can cost:** the paid lanes' budgets ($38, `loop/settings.json`), plus the gate's runs (exam tasks ×
  2 arms × $1 a run: $48 on a 24-task exam, $240 at the 120-task limit), plus sandbox time ($20 + $20 per look). The
  cap holds the model part to whatever you give it.
- **A typical week, estimated:** round 1's Relay runs on Claude Haiku 5.5, whose list prices match GPT-6 Luna's ($0.10
  and $0.50 a million tokens), cost $0.04 a run on everyday tasks and took about 4.5 minutes. With that, one proposal's
  pre-screen is 24 runs, about $1 of model spend and $0.30 of sandbox time. A gate on 24 exam tasks is 48 runs, about
  $2 and $0.60. The writers cost at most $0.38. A week with one or two proposals then costs about **$3 to $5 of model
  spend and $1 to $2 of sandbox time**. At 120 exam tasks the gate alone is about $10. These are estimates from round
  1's prices and times, not from the exam: exam tasks come from real repositories and may run longer.
- **Recommended cap:** `--spend-cap 20`. That covers a typical week with room for one more look.

## The one-time setup

1. **Approve the loop's settings:** `node loop/meta.mjs approve --by <name>`.
2. **Approve the exam's tasks**, after reading them on the review page
   (`node scripts/build-review-page.mjs --tasks-dir ../relay-exam/tasks`). One command approves every drafted task
   except the ones you name, then locks the exam:

   ```
   node scripts/approve-many.mjs --by <name> --tasks-dir ../relay-exam/tasks --except id1,id2
   ```

   It uses `scripts/approve-task.mjs`'s own code for each task. It runs only for a person at a terminal: it refuses
   without an interactive terminal, and it approves nothing unless you type the number of tasks it lists. Commit the
   exam repository afterwards.
3. **Make the anchor set once:** `node scripts/anchors.mjs create --version anchors-v1 --tasks-dir ../relay-exam/tasks
   --sample 40` (with fewer than 40 tasks, `--sample` takes them all).
4. **Keys:** the model key in the Keychain (`relay-openai`, read into `RELAY_BENCH_OPENAI_KEY` for an OpenAI model such
   as the default, `gpt-6-luna`), and `E2B_API_KEY` in `~/.zshenv`. The writer lanes also need
   `RELAY_BENCH_ANTHROPIC_KEY` (the loop's writer is never an OpenAI model, TIERS.md). Without it, written changes wait
   and the free lanes go on.

## The schedule

```
node loop/autopilot.mjs --install-schedule weekly --spend-cap 20 --signed-by <your name>
```

This writes `~/Library/LaunchAgents/com.relayevals.relay-autopilot.plist` and loads it with `launchctl`. The job runs
every Monday at 06:00 and logs to `runs/autopilot/weekly.log`. It runs
`/bin/zsh -c 'exec "$0" "$@"' <node> loop/autopilot.mjs --spend-cap 20 --signed-by <name> --keychain relay-openai`
from this folder. zsh reads `~/.zshenv`, where `E2B_API_KEY` lives, and the autopilot reads the model key from the
Keychain when it runs. The plist holds no key: the command refuses to write one that looks like it carries a key.
`--model`, `--harness`, `--exam`, `--records` and `--tasks-dir` given with `--install-schedule` are passed on. The
first Keychain read may ask once to allow `security`; choose Always Allow.

Nothing is scheduled until you run that command. `node loop/autopilot.mjs --remove-schedule` takes it away. On Linux,
the command also prints the same job as a crontab line. Its keys come from `~/.relay-autopilot.env` (keep it at
`chmod 600`), never from the line itself.

The name in `--signed-by` is the person who stands behind each ledger entry the autopilot writes. It must be a person:
the ledger refuses a model's or an agent's name. Merging the pull request is the act that ships the change.

## After a merge

The weekly run reads its earlier pull requests by itself. Once a release holds a merged one, that release becomes the
champion for the next cycle (`runs/loop/autopilot.json`). To record it straight away:

```
node loop/autopilot.mjs --after-merge <pr>
```

It finds the first stable release whose tag holds the merge commit (`gh release list`, then `git merge-base
--is-ancestor`). If no release holds it yet, it says so, and the champion stays as it was. The next ledger entry then
`--follows` the build that release shipped (GATE.md, amendment 4).

## Exit codes

0 done (a pull request opened, or nothing to propose or gate this week) · 1 a step failed · 3 no `--spend-cap` · 4
waiting on a person or a release · 10 the gate blocked · 20 the gate is unresolved.

## Files

- `runs/loop/<week>/autopilot/`: `report.md`, `state.json` (the base, the builds, the release, the gate, the spend),
  and `PR_BODY.md`.
- `runs/loop/<week>/packages/<proposal>.tgz`: each proposal's build. `runs/loop/<week>/release/relay-<build>.tgz`: the
  release's.
- `runs/loop/autopilot.json`: the champion and the autopilot's pull requests.
- `../relay-exam/runs/gate/`: the gate's records, looks and verdict. `../relay-exam/pins/<build>.json`: its graders.
- `ledger/ledger.json`: the ledger entry, written locally. Commit and push it to publish it; the autopilot never
  pushes this repository.

## What still needs real data

Everything here is tested with every outside step faked: the cycle's runs, the harness's npm scripts, git fetch and
push, `gh`, `launchctl` and the gate's runs. The real build was also run once by hand, for free: the
`queue.requestCheck.maxChecks` 2 → 3 proposal, built with this code at origin/main. `npm run check` passed, and the
package installs and prints `0.6.122-loop.2026w43`. What has not run yet:

- a paid pre-screen and a paid gate. The exam has 21 drafted tasks and 0 approved, so the first real week stops at
  "ready";
- the per-run cost and time on the exam's tasks and on GPT-6 Luna, which the estimates above take from round 1;
- `gh pr create` and `git push` against cicada0007/relay-harness, and the after-merge reading of a real release;
- the launchd job itself, including the first Keychain prompt under launchd.
