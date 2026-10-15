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
  "R0": true, "notes": { "R2": "transfer to self was accepted" } }
```

`R0` is the regression check: what worked before the request must still work (the original tests, the original
behaviour the request did not change). A requirement only counts when `R0` holds.

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
