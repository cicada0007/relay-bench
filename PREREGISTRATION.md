# Relay benchmark, round 1: pre-registration

Committed on 15 October 2026, before any paid run. Everything below decides how round 1 is run, scored and described.
The git history of this file is the record: a change after the first paid run is a new commit, explained in the commit
message, and the results page links to it.

## What is compared

Relay, an open coding-agent harness built on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), against
the tools people use directly, **on the same model**:

| Model | Tools |
| --- | --- |
| Claude Sonnet 5.5 | Relay, Prime Agent, Claude Code |
| Claude Haiku 5.5 | Relay, Prime Agent, Claude Code, Hermes |
| GPT-6.1 Sol, GPT-6 Luna | Relay, Codex (only if this round gets OpenAI credit) |

Every tool runs in its own documented unattended mode with its default settings:

- **Relay:** through its queue (`relay queue`), checks on, one model, no model team.
- **Prime Agent:** `prime-agent --autonomous --autonomous-gate "<the task's checks>" --autonomous-max-turns <limit>`.
- **Claude Code:** `claude -p` with permissions skipped inside the container.
- **Codex:** `codex exec` with approvals off inside the container.
- **Hermes:** `hermes -z "<request>" --yolo` with `-m` and `--provider` set to the model.

The exact command lines, versions and settings are written to each run's record. Versions are frozen when the round
starts and stay frozen until it ends.

## The tests

Each task has a hidden judge kept outside the repository the tool works in. A tool saying it is done never counts. Every
run is graded again on a clean copy of the result.

| Test | What | Tasks | Runs per task |
| --- | --- | --- | --- |
| A | Long requests, about 6 parts each, nobody watching, up to 3 hours | 12 | 3 (Sonnet 5.5) |
| B | The 12 long requests plus 12 everyday changes | 24 | 3 (Haiku 5.5) |
| C | Test A's long requests on GPT-6.1 Sol and all 24 tasks on GPT-6 Luna (only with OpenAI credit) | 12 and 24 | 3 |
| D | Crashes during a long request: process killed, network cut 10 minutes, model errors 10 minutes | 2 requests × 3 faults | 2 |
| E | Learning: 3 repositories × 20 tasks in a fixed order, Relay's lessons off and on | 60 | 3 passes |
| F | Terminal-Bench 2.1, the full public set, Relay and Claude Code (Haiku 5.5) | all | 2 trials |
| G | Two long-context benchmarks from Prime Agent's published table, a fixed sample of 50 tasks each (Haiku 5.5) | 100 | 1 |

In test D, tools without a supervisor get a restart loop that runs the tool's own documented resume command, as a
careful person would set up. Five of the everyday changes contain a planted decoy that looks done but fails the judge.
Six of the 24 tasks in tests A and B stay private until the round ends.

Before use, every task must pass its judge with the reference solution and fail it with no change. A person reads every
task and judge in tests A and B.

## Measures

- **Requirements met** (long requests): the share of a request's parts the judge passes.
- **Solved** (everyday changes, Terminal-Bench, long-context sets): the judge passes.
- **Checks passed** (long requests, secondary): the share of the judge's individual checks a run passes, so a part that
  is nearly done is visible as nearly done.
- **All runs pass:** the share of tasks where every run succeeded.
- **Said done but failed:** runs where the tool reported success and the judge failed it.
- **Finished with nobody** (test D): the run ended with the judge passing and no person acting.
- **Cost per solved task:** metered cost divided by successful runs. Cost comes from a local meter that reads the token
  counts in every API response for every tool, priced from the provider's public price page on the run date.
- **Tokens per task:** output tokens, from the same meter.

## Statistics

- The unit is the task. A tool's score on a task is its mean over that task's runs.
- A comparison is the mean over tasks of (Relay's score minus the other tool's score) on the same tasks.
- The 95% interval comes from a bootstrap over tasks: 10,000 resamples, seed 20261015, percentile interval.
- **Primary comparisons:** test A, requirements met, Relay against Claude Code and Relay against Prime Agent. Everything
  else is secondary and is labelled so.

## The words we may use

For each comparison, the interval decides the word, and nothing else does:

| The 95% interval of Relay minus the other tool | Word |
| --- | --- |
| Entirely above +15 points | much better |
| Entirely above 0 | better |
| Includes 0 | no clear difference |
| Entirely below 0 | worse |

Bold in a results table marks only the higher number. Losses are published in the same table, in the same type.

## Runs that break

- A run that fails because the **tool** crashed, stalled or ran out of its limits counts as a failure for that tool.
- A run that fails because of **our** infrastructure (the runner, the meter, the container host, or a provider outage
  longer than the tool's own retries) is re-run once and logged. If it fails the same way again, the task is dropped
  for every tool in that test, and the results page lists it.
- Transcripts are read for reward hacking, such as editing tests or faking output. Every case found is reported.

## Shrinking the round if costs run high

A one-run pilot of every tool and test comes first and measures the real cost per run. If a test's projected cost is
over its budget, the round shrinks in this order, and the results page says what was cut:

1. Test G samples 25 tasks per set instead of 50.
2. Test F runs 1 trial per task instead of 2.
3. Test B runs everyday changes 2 times instead of 3.
4. Test E runs 2 passes instead of 3.

Test A is never shrunk. If it cannot run in full, the round stops and the decision goes back to the founders.

## Honesty notes, decided now

- Where our run of another tool scores below that tool's own official public number on the same benchmark and model,
  the table shows the official number and says so.
- No model is trained around Relay or Prime Agent. The models of Claude Code and Codex are trained around them.
- Relay is built on Prime Agent. Results Prime Intellect published for Prime Agent belong to Prime Agent.
- A flat learning curve in test E is published like any other result.

## What gets published

Tasks (the private six after the round), judges, the runner, the meter, every run's record and transcript, costs,
failures, and one command per test to re-run it.

## Amendments

### 1. Long requests sized for hours (15 October 2026, after the pilot, before any counted run)

The pilot ran Relay, Prime Agent and Claude Code once each on one long request, on Sonnet 5.5. All three met all 6
parts, in 2 to 8 minutes, for $0.29 to $0.93. Blind attempts on five more of the first-draft requests also met every
part. Test A is meant to measure work of up to 3 hours with nobody watching, and a test every tool passes in minutes
cannot separate them: every comparison would read "no clear difference".

So the long requests are rebuilt larger, by rules fixed here, before any tool runs them (TASK_FORMAT.md has the detail):
a starting repository of 3,000 to 5,000 lines with at least 60 tests; 6 parts, each with 5 to 10 precisely specified
behaviours; a reference solution of at least 2,000 changed lines; 6 to 15 judge checks per part.

- The rules apply to every task alike. No task is kept, changed or dropped because of how any one tool did on it.
- The first-draft requests are not used in any counted test. The pilot's three records stay in the published data,
  labelled as the pilot.
- "Checks passed" is added as a secondary measure. The primary measure and every word rule are unchanged.
- No tool's endpoint setting is changed to meter it. Claude Code turns some features off when its endpoint is changed
  (its own messages say they are "not available with a custom ANTHROPIC_BASE_URL"), and Hermes drops the model's
  thinking for any endpoint not on anthropic.com. So inside each run's container, api.anthropic.com resolves to the
  meter, which answers with a certificate from an authority made for that one run (its signing key is deleted at
  once) and forwards every request unchanged. Prime Agent 0.10.0 trusts only its built-in certificate list, so it alone
  reaches the meter through its endpoint setting, which in that version only builds the request URL. The pilot's runs
  used endpoint settings for every tool.
- Runs per task, the model and the budget for test A are set from the cost of a pilot on the larger requests. If test A
  cannot run in full within its budget, the decision goes back to the founders, as the section above says.

### 2. What the large pilot changed (16 October 2026, before any counted run)

The pilot ran the first two larger long requests (node-spreadsheet, py-mini-sql) on Sonnet 5.5 and, for cost, on
Haiku 5.5. Every change below applies before any counted run; the pilot's records stay in the published data.

- **Relay was fixed before the round.** Relay 0.6.117 met 1 of 6 parts on one request and 0 on the other, where Claude
  Code and Prime Agent met all 6 on both. The pilot showed four defects in Relay, all generic: a planned task's agent
  saw only the planner's short brief, never the request; the planner could leave parts of a request out; reviews cut a
  request at 12,000 characters; and setup did not read the README for the test command, so on one repository it ran
  nothing. They are fixed in Relay 0.6.118 (relay-harness pull request 195), which the round pins. A build of that fix
  met 6 of 6 on the request where 0.6.117 met none. Nothing in the fix is specific to any task, and the two pilot tasks
  are marked on the results page as the tasks the defects were found on.
- **Prime Agent is told the test models.** Prime Agent 0.10.0's built-in model list stops at Sonnet 5 and Haiku 4.5;
  for a model it does not know it falls back to 4,096 output tokens and no thinking. Its models.json declares the test
  model with Anthropic's limits, as a user adopting a new model would. On Sonnet 5.5 it then asks for adaptive thinking
  at medium effort, as Claude Code does. On Haiku 5.5 it runs without thinking, because 0.10.0 sends that model an older
  thinking format the API refuses; the results page says so.
- **The budget is re-split within $400**, decided by the founders on 16 October: on large requests Haiku 5.5 costs about
  as much as Sonnet 5.5 (its long-context price applies above 100,000 tokens), so test B as written would cost about
  $230, not $60.

  | Test | Change | Cap |
  | --- | --- | --- |
  | Pilot | spent | $19.52 |
  | A | unchanged: 12 long requests, 3 runs each, Sonnet 5.5 | $190 |
  | B | the 12 everyday changes run 3 times each; the 12 long requests run once each | $80 |
  | D | one long request, 3 faults, 2 runs each | $25 |
  | F | unchanged | $45 |
  | G | unchanged | $25 |
  | E | runs only if money is left after the tests above | rest |

  Test A is unchanged and unshrunk. Every cut is listed on the results page.

### 3. Who reads the tasks, and which tests run (16 October 2026, before any counted run)

- **The read-through is delegated.** The founders asked for an independent review in place of their own reading of
  every task and judge. A separate model reads each request beside its judge and its CHECKS.md, and asks one question
  of every check: would a careful developer who read only the request build what this check expects? A check that
  fails that test is fixed (the judge accepts every reasonable reading, or the request states what the check needs)
  before any counted run, so the fix applies to every tool alike. Each review is kept in `reviews/` and published with
  the tasks after the round, so anyone can read the same tasks and judge the reviews.
- **Tests run in round 1:** A, B and D, then F (Terminal-Bench 2.1) and G (two long-context sets) once their runners
  are built, within the $400. **Not run in round 1:** C, because the round has no OpenAI credit, and E, because it needs
  a Relay change (lessons that can be held still) and 60 further tasks. The results page lists both as not run.
