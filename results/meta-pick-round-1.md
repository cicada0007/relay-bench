# The picker exam on round 1 (24 Oct 2026)

`meta/pick-exam.mjs` put the meta-harness picker (`meta/pick.mjs`) in front of pairs of attempts that round 1 already
ran and graded, and scored the attempt it chose. No harness ran again. The picker saw each attempt's actions and their
outputs (Terminal-Bench) or its patch and the project's own test and lint results (test A), never the harness's own
words about its work, never the hidden tests, and never which harness made which attempt.

Only pairs the grader scored differently need a choice; on every other pair any choice scores the same.

## Results, gpt-6.1-sol picker, medium effort

| Test | Pairs | Graded differently | Claude Code alone | Picker's choice | Grader's choice |
|---|---:|---:|---:|---:|---:|
| Terminal-Bench 2.1: Relay + Claude Code, same trial number | 174 | 42 | 83.3% | 86.2% | 89.7% |
| Terminal-Bench 2.1: Claude Code trial 1 + trial 2 | 86 | 12 | 83.7% | 87.2% | 90.7% |
| Test A: Relay + Claude Code, same run number | 34 | 11 | 98.5% | 98.0% | 99.0% |

"Claude Code alone" is Claude Code's attempt in each pair (trial 1 in the second row). "Grader's choice" is the
attempt the hidden grader scored higher, which no picker can see.

Where the picker chose a different attempt than Claude Code's (first row: trial 1's):

| Test | Chose another attempt | Grader scored it higher |
|---|---:|---:|
| Terminal-Bench, Relay + Claude Code | 11 | 8 |
| Terminal-Bench, Claude Code + Claude Code | 5 | 4 |
| Test A | 1 | 0 |

Across both Terminal-Bench rows, 12 of 16 changes were to the attempt the grader scored higher (two-sided sign test,
p = 0.077).

## Cost

| Test | Claude Code alone | Both attempts | Picker |
|---|---:|---:|---:|
| Terminal-Bench, Relay + Claude Code | $6.90 | $10.90 | $1.56 |
| Terminal-Bench, Claude Code + Claude Code | $3.23 | $6.89 | $0.41 |
| Test A | $68.50 | $128.61 | $0.89 |

The picker is billed only for the pairs it was asked about; in use it would be asked about every pair.

## The same exam with gpt-6-luna

| Test | Claude Code alone | Picker's choice | Picker cost |
|---|---:|---:|---:|
| Terminal-Bench, Relay + Claude Code | 83.3% | 86.2% | $0.03 |
| Terminal-Bench, Claude Code + Claude Code | 83.7% | 84.9% | $0.01 |
| Test A | 98.5% | 98.0% | $0.01 |

## What was left out, and why

- `terminal-bench/qemu-alpine-ssh` and `terminal-bench/qemu-startup`, dropped for every tool in round 1.
- One split pair, `terminal-bench/financial-document-processor` Claude Code trial 1 + trial 2: trial 2 kept no record of
  its actions.
- Trials whose transcript survived only as `claude-code.txt` (Claude Code's stream) or `relay.jsonl` (Relay's event
  stream) were read from those files.

Spend: $3.07 of OpenAI calls in all (`runs/meta/pick-spend.json`, cap $4), both pickers included, and $0.16 of it a first gpt-6-luna run made before the two stream readers existed.
