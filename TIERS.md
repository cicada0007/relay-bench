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
