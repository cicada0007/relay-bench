# The gate: is a new Relay at least as good as the current one?

The gate answers one question before a release reaches anyone: is the candidate Relay at least as good as the
champion (the Relay people have now)? These rules are fixed here, before any gate run, and change only by a dated
amendment at the end of this file, committed before the runs it affects.

## What runs

- **Two arms, one tool.** The champion and the candidate are both Relay, named `relay@<version>`, for example
  `relay@0.6.121` and `relay@0.6.122-beta.3`. Everything else is the same for both: the tasks, the model, the time
  limit, the spend cap per run, the sandbox image and the meter.
- **Released versions only, for a counted gate.** Each run installs its version with Relay's own installer
  (`RELAY_VERSION=<version>`), and the record keeps what `relay --version` printed. A build that is not released can
  only be pre-screened, in a test whose name starts with `dev` or `pilot` (`relay@pkg` with `--relay-package`).
- **Tasks.** The tier named in the command (TIERS.md). A counted gate refuses tasks that differ from their lock.
- **Paired.** Every task runs for both arms, the same number of times.

## How it is scored

- The unit is the task. An arm's score on a task is its mean share of requirements met over that task's runs,
  in points (0 to 100). A run our infrastructure lost (no grade) is left out, as in PREREGISTRATION.md.
- **Difference:** the mean over shared tasks of (candidate − champion), with a 95% interval from the same bootstrap as
  `runner/analyze.mjs` (over tasks, 10,000 resamples, seed 20261015).
- **Cost:** the sum over shared tasks of each arm's mean metered cost, as a ratio candidate ÷ champion.
- **Time:** the same, with each run's wall time.
- **False "done":** the share of runs where the tool said it finished but the judge found it had not, candidate minus
  champion, in points.
- **Segments:** the same difference for each kind of task (`long`, `everyday`, and any other kind the tier holds).

## The verdict

In this order; the first rule that applies decides.

1. **UNRESOLVED, too few tasks**, when fewer than 20 tasks have a grade for both arms.
2. **BLOCK, worse**, when the whole interval is below zero.
3. **BLOCK, worse on a kind of task**, when a kind with at least 8 shared tasks has its whole interval below −5.
4. **BLOCK, costs more**, when the cost ratio is above 1.05.
5. **BLOCK, slower**, when the time ratio is above 1.10.
6. **BLOCK, more false "done"**, when the false "done" difference is above +5 points.
7. **PASS, better**, when the whole interval is above zero.
8. **PASS, no worse**, when the interval's low end is above −5 (the non-inferiority margin).
9. **UNRESOLVED**, otherwise: the gate cannot rule out a drop of more than 5 points. More tasks, or more runs per
   task, are needed.

A kind with fewer than 8 shared tasks is reported as too few to judge on its own. The gate also prints the smallest
change it could have seen at 80% power, so a PASS on a small tier is never read as more than it is.

A PASS lets a founder sign the release. It never ships one by itself.

Exit codes: 0 PASS, 10 BLOCK, 20 UNRESOLVED, the same as Relay's own verdicts.

## Amendments

None yet.
