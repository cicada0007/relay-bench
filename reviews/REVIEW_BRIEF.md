# Independent task review: brief for each reviewer

PREREGISTRATION.md amendment 3: before any counted run, an independent reviewer reads each request beside its judge and
asks of every check one question:

> Would a careful developer who read only `request.md` (and the starting repository's own README and code) build what
> this check expects?

You did not build these tasks. Be the skeptical reader a competitor's engineer would be.

## For each task you are given (`tasks/<id>/`)

1. Read `request.md`, then `judge/CHECKS.md`, then the judge's actual check code (`judge/checks/*.mjs` or
   `judge/hidden/*.py`) and enough of `repo/` (README first) to know what the starting product already states.
2. For every check, decide one of:
   - **fair**: the request (or the starting README/code it builds on) states the expected behaviour, or the check
     accepts every reasonable reading.
   - **unfair**: the check needs a name, wording, format, order, error text or edge-case behaviour that the request does
     not state and a careful developer could reasonably do differently. Also unfair: a check that depends on another
     part working (breaks independence), or on timing that a correct but slower implementation could miss.
3. Fix every unfair check, the same for every tool: either make the judge accept every reasonable reading, or add the
   missing statement to `request.md` (only where the statement is what the product plainly should do, and keep the
   request's voice). Prefer relaxing the check over growing the request. Keep `judge/CHECKS.md` in step.
4. Re-validate: `PATH=/Users/scriptonia/.nvm/versions/node/v22.23.1/bin:$PATH node scripts/validate-task.mjs <id>` must
   print ok. If you changed a long task's judge, confirm with a copy of the reference with that part removed that only
   that part goes false.
5. Check the decoy (everyday tasks with `"decoy": true`): is it fair, i.e. do the request's own words show what is
   wrong with what is already there? If not, fix the request.

## Write `reviews/<id>.md` for each task

- A one-line verdict: `fair as built`, or `fair after fixes`.
- Every check you judged unfair: its name, why, and exactly what you changed.
- Anything you considered and left alone, with the reason (one line each).

Rules: work only in your tasks' folders and `reviews/`; do not commit; no network; do not run any coding-agent product
or start other agents. Node commands need the PATH prefix above. Python is standard library, 3.9-compatible.

Report back in short: per task, the verdict and the number of checks changed.
