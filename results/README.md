# Results

`round-1.json` is round 1's results, as the results page at relayevals.com/ai-coding-agent-benchmark shows them.

It is written by one command, from the run records in `runs/round-1/`:

```
node scripts/export-results.mjs
```

Every number comes from the round's own analysis code, imported rather than re-derived: `runner/analyze.mjs` for tests
A, B and D, `runner/tb21-analyze.mjs` for test F and `runner/longctx-analyze.mjs` for test G. Those files apply the
rules in [PREREGISTRATION.md](../PREREGISTRATION.md): the task is the unit, each comparison is Relay minus the other tool
with a 95% bootstrap interval over tasks (10,000 resamples, seed 20261015), and the interval alone picks the word.

What the file holds:

- For each test and tool: runs, the test's measure (requirements met or solved), checks passed, all runs pass, said done
  but failed, cost, cost per solved task and median minutes. Test D adds, for each fault, how many runs finished with
  nobody acting.
- For each test: Relay minus each other tool, with its interval and word.
- Each test's status. A test still running is marked `"in progress"` and holds the runs recorded so far, so its
  numbers will change.
- The runs the plan called for that were not made, tests not run (C and E) and why, the round's cuts, the pinned
  versions and the metered spend.

It holds no task contents: no request, judge, repository, answer or per-task score. The tasks are published after the
round ends.
