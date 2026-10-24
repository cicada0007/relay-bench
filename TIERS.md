# The three tiers of tasks

Relay improves itself from tasks it can study, and is judged on tasks it never sees. Published self-improving agents
game whatever they can reach (the Darwin Gödel Machine faked logs saying tests had passed; METR found reward hacking in
30% of runs on one benchmark), so the tasks are split three ways. The gate (GATE.md) runs on any tier; only a gate on
the exam lets a founder sign a release.

| Tier | Where the tasks live | What the improving agent may see | Today |
| --- | --- | --- | --- |
| Practice | this repository's `tasks/` folder, and Terminal-Bench 2.1's public set | everything: tasks, runs, judges' results | 24 tasks and 89 |
| Check | the private exam repository, tasks marked `"tier": "check"` | pass or fail only, through `scripts/check-query.mjs` | none yet |
| Exam | the private exam repository, tasks marked `"tier": "exam"` | nothing at all | none yet |

## The exam's rules

- **Sealed.** The exam's tasks, judges and lock live in a private repository outside this one. `runner/gate.mjs`
  refuses `--tier exam` or `--tier check` with a tasks folder inside this public repository, and the lock of a tasks
  folder is the `TASKS.lock.json` beside it (`scripts/lock-tasks.mjs --tasks-dir`), so the exam's lock stays private too.
- **Graded outside the tool.** Every run is graded by its hidden judge in a fresh sandbox the tool never saw, as in
  round 1 (TASK_FORMAT.md).
- **Written by another model family.** Exam tasks are drafted by a different model family from the one doing the
  improving, and every task is approved by a founder who did not write it.
- **Checked by hand.** One run in ten has its judge's grade checked by a person each month. A judge that disagrees with
  people more than one time in ten is fixed for every tool alike, and its tasks are graded again.
- **Fresh.** New tasks come in each month from public issues filed after the models' training cutoffs, so the exam
  keeps measuring work the models have not seen.
- **Overfitting alarm.** When Practice scores rise and Exam scores do not, the improvement loop is learning the
  practice tasks rather than getting better.
- **Counted.** Every run of an exam or check task, and every result read that depends on one, is counted against a
  leak budget kept beside the exam (GATE.md, amendment 1). A task past its budget is spent and replaced.
- **Anchored.** A fixed, versioned set of exam tasks is scored with every release, so the quarter's trend is read on the
  same tasks while the rest of the exam changes (GATE.md, amendment 1).

## Growing the exam

The target is about 400 tasks (the Relay Body Plan): enough for a gate to see a change of about 6 points. Until the
exam has 20 tasks, a gate on it reports UNRESOLVED (too few tasks), and gates run on Practice only.

**Not yet run.** The tools below are built and tested on recorded and made-up data only; no task has been mined,
drafted or approved with them yet. RUNBOOK.md ("Growing the exam") has the exact commands.

How one exam task is made, in order:

1. **Found.** `scripts/mine-tasks.mjs` reads the GitHub API (read-only, the caller's token) for merged pull requests that
   close an issue opened after a cutoff date (the models' training cutoffs) and add or change tests, in small Node or
   Python repositories under a permissive license that need no package from the network (TASK_FORMAT.md, "Toolchain").
   Pull requests by bots or marked as written by a coding agent are left out, and so are the two repositories whose
   recorded API responses are this repository's test fixtures. Each candidate records its repository, base commit, issue
   and pull request, in a file kept beside the exam, never here.
2. **Drafted.** `scripts/draft-task.mjs` builds the task folder in the exam repository: `repo/` at the pull request's
   base, `reference/` at its head, and a hidden judge from the pull request's own tests (`scripts/exam-judge/`). R1 is
   the tests the pull request added or changed that fail on `repo/` and pass on `reference/` twice; R0 is every test
   that passed on both. Then a model from a different family than the one being improved (OpenAI) writes `request.md`
   from the issue alone: it never sees the fix, its instructions forbid saying how to fix it, and a draft that still
   repeats a line of the fix, or names the issue or pull request, is refused. The judge is checked before the model is
   called, so a candidate that cannot be judged costs no model call. That check runs the candidate's own tests, someone
   else's code, so it runs in an E2B sandbox with no keys, never on the drafting machine. Every model call and sandbox
   is bounded before it starts and counted against its cap in the drafting ledger beside the exam.
3. **Validated** with `scripts/validate-task.mjs --tasks-dir`, like every task: the judge fails the untouched repository
   and passes the reference.
4. **Approved.** A founder reads the task on the exam's review page (`scripts/build-review-page.mjs --tasks-dir`, a
   local file beside the exam that the script never publishes) and approves it with `scripts/approve-task.mjs`, which
   refuses an approver who drafted the task.
5. **Locked.** `scripts/lock-tasks.mjs --tasks-dir` records each task's fingerprints and who approved it. A counted run
   refuses an exam or check task that is not approved, approved by its own drafter, or changed since the lock.

## The living exam

The exam gets harder by itself. New post-cutoff tasks come in every week, and a harder level opens when one is passed
90% of the time. Relay proposes tasks; people approve them; Relay never grades its own exam. **Not yet run**, like the
tools above: everything here is tested on made-up data only.

- **Every week, one command.** `scripts/living-exam.mjs` runs the steps above in order: mine, filter, contamination
  scan, draft queue, approval queue, lock, and saturation. Each step runs only when its inputs exist and says why when
  they do not. Mining runs only when asked (`--mine`), since another miner may already be adding candidates, and with
  the miner's usual command line. Drafting is the one paid step. Without `--spend-cap` the pipeline stops before it and
  says what is waiting and the most it could cost. With a cap it drafts while its estimate ($0.05 a candidate) fits.
  Approving is a person's: the pipeline only queues the tasks and builds the local review page.
- **The contamination scan.** `scripts/contamination.mjs` checks every candidate before drafting, and every drafted
  task again before approval, against everything the improving loop can see. That covers every file tracked in this
  public repository (fixtures, results and reviews included), the practice tasks, and every task the exam holds or has
  retired. It also compares candidates with each other. A candidate is rejected, with its reasons, when any of these
  hold:
  - it is the same pull request or issue as one seen before;
  - its issue or pull request is named anywhere in that text;
  - its repository is the source of a practice task or a public fixture;
  - most of its 5-word runs appear in one visible document (containment or Jaccard of 0.5 or more);
  - its issue opened, or its fix merged, on or before the training cutoff, or it was mined with an earlier cutoff.
- **The check tier's one door.** `scripts/check-query.mjs` answers one question, did this candidate pass the gate on the
  check tasks, with one word: pass or fail. Every new answer is one read of each check task it covers, counted against
  the leak budget (GATE.md, amendment 1). Past the budget it answers nothing.
- **Saturation.** `scripts/saturation.mjs` reads the champion's latest 50 runs per tier and level. When at least 90% of
  them meet every requirement, the level no longer tells releases apart. It is flagged, and `queue/harder.json` opens
  the next level's draft queue. A level is a band of change size. Level 1 is anything the miner keeps. Level 2 is at
  least 120 changed lines over at least 2 source files. Level 3 is at least 250 lines over at least 4 files.
  Candidates of a level that is not open yet wait in the queue. `scripts/draft-task.mjs --level` records the level in
  `task.json`.
- **Graders pinned per release.** Before a release's gate on the exam, every locked task's judge fingerprint is written
  under the release's id (`pins/<release>.json`, by `runner/gate.mjs --run` or `scripts/pin-graders.mjs`). A judge
  fixed later still grades every tool's runs again. But the release's gate refuses any run graded by a judge other than
  its pinned one, so a release is never judged by a grader that did not exist when it was gated. `runner/rejudge.mjs`
  records each re-grade's judge fingerprint for this.

Everything the pipeline writes goes beside the exam, in `queue/`: the filtered, scanned, clean, waiting, rejected and
approval lists, and the saturation readings.

An exam task's `task.json` has the fields of TASK_FORMAT.md plus:

| Field | What it holds |
| --- | --- |
| `tier` | `"exam"` or `"check"` |
| `level` | the size band it was mined in, 1 to 3 (scripts/saturation.mjs) |
| `draftedBy` | who wrote the request: `openai/<the model id the API reported>` |
| `draftedAt` | when |
| `source` | the issue and pull request URLs, the base and head commits used, the license, and the issue's and merge's dates |
| `approvedBy`, `approvedAt` | the founder who approved it, and when (written by `approve-task.mjs`) |

Runs of exam and check tasks are written outside this repository too: `runner/run-stage.mjs` refuses an exam or check
task from a folder inside it, and refuses to write their runs inside it, for every test, counted or not.

**The hand check.** Each month `scripts/handcheck.mjs` draws 1 run in 10 from a records file into a sheet, one row per
part of each drawn run; a person marks each row agree or disagree with the judge. `scripts/grader-agreement.mjs` reads
the marked sheets and flags every judge people agree with less than 90% of the time (more than one disagreement in ten),
which is then fixed for every tool alike and its tasks graded again (`runner/rejudge.mjs`).

## The improvement loop

The loop (`loop/`, RUNBOOK.md "The improvement loop") proposes changes to Relay every week and never ships one. **Not
yet run**: tested on made-up data only.

- **What it reads.** Runs of practice tasks and public tasks (Terminal-Bench 2.1), with the queue report Relay wrote in
  each run. A records file inside the exam's folder, or holding a run of an exam or check task, is refused whole. Of the
  check tier it sees one word per question, through `scripts/check-query.mjs`, counted against the leak budget and capped
  per cycle. Of the exam it sees nothing; a release reaches the exam only through the gate.
- **What it proposes.** One change per lane: config, routing, memory, tools, prompts and skills, architecture (a diff
  to the harness's `relay.arch.json`, D-91, and the code that holds a value when relay.arch reads it from code), and
  exam proposals. The routing lane includes the meta-harness's router (`router.table`, `router.verifierShare`,
  `router.minArmUsd`, D-101), proposed from the benchmark's arm outcomes (`results/arm-outcomes.jsonl`, public tasks
  only) when the cycle is given them. Runtime is documented only. A writer lane's change must stay inside the one prompt it edits, and is
  refused when it names anything from the practice failures it was shown, since it would learn the task, not the skill.
- **Taught skills** (TEACHING.md): a skill candidate graduated from lessons many machines chose to share
  (`teaching/graduate.mjs`, at least 5 machines and 25 passing uses) is a prompts-and-skills proposal that adds one new
  SKILL.md, checked and gated like any other; it never becomes a base skill any other way.
- **Exam proposals** are kinds of task to mine more of (a language, a kind, a level), queued for a person in
  `queue/loop-proposals.jsonl`. A task the loop picked would be one it has seen, so it never proposes a task, and it
  never approves anything.
- **What it may never change** (`loop/lanes.mjs`, INVARIANTS): the release's ceilings and spend caps; the trusted core
  (release signing and trust, the installer, the switch-off list, the audit log, project trust, and the gates and scope
  a task must pass); the exam's contents and approval; the graders; the gate's rules, the check tier's door, the ledger
  and the loop's own rules; and tenant data. A proposal is checked from the JSON paths and files its change touches,
  never from what it says about itself, and one that reaches an invariant is refused before anything is spent.
- **The meta loop** judges the loop's own settings (lane budgets, which lanes run, proposals per lane, the cluster
  thresholds) by gated gain per dollar over the last cycles, read from the ledger. It proposes changes and a person
  applies them; it never raises the total budget or touches the pre-screen's sizes.

