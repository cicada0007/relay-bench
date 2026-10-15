# Task format

Every task in `tasks/<id>/` has the same shape, so one runner and one judge harness can run any of them with any tool.

```
tasks/<id>/
  task.json        what the task is (below)
  request.md       the exact text every tool receives, nothing else
  repo/            the starting repository, committed as a git repo by the runner (no .git in this folder)
  judge/           the hidden judge; never copied into the repository a tool works in
    judge.mjs      node judge/judge.mjs <checkout>  ->  prints one JSON line (below) and exits 0
    ...            anything else the judge needs (hidden tests, fixtures)
  reference/       a full working tree that meets every requirement (the reference solution)
```

## task.json

```json
{
  "id": "py-ledger",
  "kind": "long",                      // "long" (multi-part request) or "everyday" (one change)
  "title": "Bank ledger in Python",
  "stack": ["python3"],                // what the sandbox must have; see "Toolchain" below
  "requirements": ["R1", "R2", "R3", "R4", "R5", "R6"],
  "timeLimitMinutes": 180,             // 180 for long requests, 45 for everyday changes
  "gates": { "test": "python3 -m unittest discover -s tests -q", "lint": "python3 -m compileall -q src tests" },
  "private": false                      // true for the 6 holdout tasks
}
```

`gates` are the repository's own check commands, named in its README. Every tool may run them. The judge runs them too.

## request.md

Written like the overnight kit's `prompt.md`: a short opening line, then numbered parts, each concrete and checkable,
then the rules that apply to every part (tests required, where they go). It names behaviour, not implementation, unless a
part is about structure (for example "put the formatting in a pure function in `src/`"). It never mentions the judge.

A long request has about 6 parts: usually 3 or 4 features, 1 bug fix in existing code, and 1 documentation or
refactoring part. An everyday change is one part.

A long request is sized for hours of work, not minutes (the first draft of 12 requests was solved completely in 2 to 8
minutes by every tool in the pilot). Every long task meets all of these, by construction, before any tool runs it:

- The starting repository has 3,000 to 5,000 lines of source code (tests not counted) in at least 12 files across at
  least 3 modules, and at least 60 existing tests that pass.
- Each of the 6 parts is a substantial change with 5 to 10 precisely specified behaviours and touches at least 2
  modules. The request is about 1,500 to 2,500 words.
- The reference solution changes at least 2,000 lines, tests included.
- The judge checks each part with 6 to 15 checks, and a part is met only when all of its checks pass.

No task is kept, changed or dropped because of how any one tool did on it. A run may show that a request can be read
two ways; the fix is then to make the judge accept every reasonable reading, and it applies to every tool.

## The judge

`node judge/judge.mjs <checkout>` runs on a clean copy of the result, in a sandbox the tool never saw. It must:

1. Install dependencies the way the README says, then run every gate in `task.json`.
2. Check each requirement **by behaviour**: call the API, run the CLI, import the module, run hidden tests. Never by
   reading the tool's own tests or grepping for strings, except for a structure or documentation requirement, where it
   checks the smallest thing that proves it (for example: the function exists in `src/` and has tests that pass).
3. Print exactly one line of JSON to stdout and exit 0, even when everything fails:

```json
{ "task": "py-ledger", "gates": { "test": true, "lint": false },
  "requirements": { "R1": true, "R2": false, "R3": true, "R4": true, "R5": false, "R6": true },
  "R0": true, "checks": { "R1": [9, 9], "R2": [6, 7] }, "notes": { "R2": "transfer to self was accepted" } }
```

`R0` is the regression check: what worked before the request must still work (the original tests, run from a hidden
copy in `judge/`, and the original behaviour the request did not change). A requirement only counts when `R0` holds.
`checks` gives, for each part, the checks passed and the checks in total; it feeds the secondary measure "checks passed".
`R0` does not include the gates: they also run the tool's own new tests, and are reported separately in `gates`, so
one failing test the tool wrote is visible without zeroing every requirement.

Rules for judges:
- Deterministic: no network, no randomness without a fixed seed, no sleeps longer than needed.
- Fast: under 5 minutes on 2 vCPUs.
- Strict but fair: accept any reasonable implementation of what `request.md` says; never require a name, file or wording
  the request did not ask for.
- Self-contained: Node 22 standard library only, plus the task's own stack.

## Validation (every task, before it is used)

```
node judge/judge.mjs repo        ->  every requirement false, R0 true
node judge/judge.mjs reference   ->  every requirement true,  R0 true, every gate true
```

`scripts/validate-task.mjs <id>` runs both and fails loudly otherwise. A person then reads `request.md` and the judge.

## Toolchain

The benchmark sandbox has: git, Node 22 (npm) and Python 3 (standard library only; code must run on Python 3.9 and
newer, so it runs the same on the machine that validates tasks and in the sandbox). Chromium for Playwright is there for
the one task that needs a browser. Python tasks test with `unittest`, not pytest. Node tasks test with `node --test`.
No task installs packages from the network: the standard library only, or a dependency vendored in `repo/`.

## Relay's result

Relay's queue works each task on its own branch. Its result is what a reviewer would merge: the verified task branches
merged onto the starting branch in plan order. The other tools edit the working tree in place; their result is the
working tree at the end of the run, committed or not.
