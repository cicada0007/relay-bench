# The three tiers of tasks

Relay improves itself from tasks it can study, and is judged on tasks it never sees. Published self-improving agents
game whatever they can reach (the Darwin Gödel Machine faked logs saying tests had passed; METR found reward hacking in
30% of runs on one benchmark), so the tasks are split three ways. The gate (GATE.md) runs on any tier; only a gate on
the exam lets a founder sign a release.

| Tier | Where the tasks live | What the improving agent may see | Today |
| --- | --- | --- | --- |
| Practice | this repository's `tasks/` folder, and Terminal-Bench 2.1's public set | everything: tasks, runs, judges' results | 24 tasks and 89 |
| Check | the private exam repository, tasks marked `"tier": "check"` | pass or fail only | none yet |
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
   called, so a candidate that cannot be judged costs nothing.
3. **Validated** with `scripts/validate-task.mjs --tasks-dir`, like every task: the judge fails the untouched repository
   and passes the reference.
4. **Approved.** A founder reads the task on the exam's review page (`scripts/build-review-page.mjs --tasks-dir`, a
   local file beside the exam that the script never publishes) and approves it with `scripts/approve-task.mjs`, which
   refuses an approver who drafted the task.
5. **Locked.** `scripts/lock-tasks.mjs --tasks-dir` records each task's fingerprints and who approved it. A counted run
   refuses an exam or check task that is not approved, approved by its own drafter, or changed since the lock.

An exam task's `task.json` has the fields of TASK_FORMAT.md plus:

| Field | What it holds |
| --- | --- |
| `tier` | `"exam"` or `"check"` |
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
