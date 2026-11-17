# Gate 2c on Amazon Bedrock: Relay 0.6.132 against Claude Code

Written 17 Nov 2026, before the first run. Plan: `plans/plan.md`, phase 2c. The rule below was fixed in that plan
before any run and is copied here unchanged; only the model and the provider differ from the plan, at the founder's
word of 17 Nov 2026 (use the AWS Bedrock API, not OpenAI).

## The rule (fixed before any run)

Same 12 long tasks, same model, one run each, Relay against Claude Code:

1. Relay meets **at least as many requirements as Claude Code**, and
2. of the tasks Relay calls done, **at most 1 in 4** has an unmet requirement, and
3. Relay's total time is **at most 1.5 times** Claude Code's.

Pass or fail, the result is published as numbers only (no better or worse words).

"Calls done": the runner's `saidDone` (runner/arms.mjs). For Relay, every planned task ended verified and none is
partly proven (a verified task with a requirement Relay's own checks marked "not met", Relay 0.6.132, D-115). For
Claude Code, its final JSON line is a success. "Requirements met": the hidden judge's count, 6 per task, 72 in all.
"Time": the tool's wall time inside the sandbox, summed over the 12 runs.

## Setup

| | |
|---|---|
| Tasks | the 12 long tasks of the November run: node-build-runner, node-http-framework, node-kv-store, node-package-resolver, node-spreadsheet, node-template-engine, py-calendar, py-dataframe, py-issue-tracker, py-mini-sql, py-text-adventure, py-vcs-lite (`relay-bench/tasks`, 180 minute limit each) |
| Model | `qwen.qwen3-coder-next` on Amazon Bedrock (bedrock-mantle, us-east-1, OpenAI-compatible Chat Completions), $0.50 in / $1.20 out per million tokens. Mantle reports no cached tokens for it, so every prompt token is metered at the input price |
| Relay | released 0.6.132 (`relay@0.6.132`), installed in each sandbox by Relay's own installer (native build), meta-harness on (`RELAY_META=1`, its default), its own agent on the test model on every tier through its `openai` provider (models.json names the model). Codex and Claude Code are not signed in, so Relay's own agent does all the work |
| Claude Code | 2.1.300 (the image's pin), `claude -p ... --dangerously-skip-permissions`, every model tier pinned to the test model. Its Messages requests are translated to Chat Completions by the meter (`meter/anthropic-chat.mjs`) |
| Meter | `meter/meter.mjs` in each sandbox at api.openai.com and api.anthropic.com, forwarding model calls to Bedrock under the meter's own key (`--bedrock-upstream`); tools hold a stand-in key |
| Sandbox | E2B template `relay-bench-small-1` (2 vCPU, 4 GiB), one fresh sandbox per run, judged in a second fresh sandbox |
| Order | smoke first: node-build-runner, both arms. The full run only if the smoke's cost, times 12 tasks, plus 30%, fits both caps |

## Caps

- Bedrock (meter): **$40** in all, smoke included. E2B: **$10** in all.
- Each run has the same meter cap for both arms (`--cap-usd`), and Relay gets the same figure as its own `--spend-cap`.
  Smoke: $3 a run. A run that reaches its cap is cut off there and judged as it stands.
- run-stage.mjs launches a run only while spent + runs in flight x cap + one more cap stays within the stage cap, and
  counts sandbox seconds against the E2B cap at $0.000046 a second.

## Projection, fixed before the smoke

Projected model spend = 12 x (smoke Relay $ + smoke Claude Code $). Continue only if 1.3 x projected <= $40 and
1.3 x (12 x smoke E2B $) <= $10. A smoke arm that reaches its $3 cap makes the projection at least 12 x $3 = $36,
times 1.3 = $46.80, which does not fit: the gate then stops after the smoke and reports.

## Commands

```
node runner/run-stage.mjs --test pilot-gate2c --model qwen.qwen3-coder-next --tools relay@0.6.132,claude-code \
  --tasks node-build-runner --reps 1 --cap-usd 3 --stage-cap-usd 6 --e2b-cap-usd 2 --concurrency 2 \
  --relay-meta --out runs/gate-2c-bedrock --tasks-dir ../relay-bench/tasks
```

Keys: the Bedrock key from the Keychain item `relay-bench-bedrock` into the stage's environment only
(RELAY_BENCH_BEDROCK_KEY), then the meter's; E2B_API_KEY from the shell's environment. OPENAI_API_KEY,
ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL are unset.

## Amendment 1 (17 Nov 2026, 09:45 UTC, during the smoke, before any Relay work)

Relay 0.6.132's first smoke run planned the request (6 tasks, $0.005) and then refused `relay queue run`: "Sign in to
Relay first. Run relay login, then start the run again." (D-81, sign in first). Nobody can sign in inside a benchmark
sandbox. The Relay arm now sets `RELAY_SIGN_IN_FIRST=0`, the switch Relay reads for this
(`core/relay-account/sign-in-first.ts`); the $20-per-machine sign-in rule (D-71) still applies and no run's cap comes
near it. The refused run is kept as `void-records.jsonl` and not counted; Relay's smoke run starts again, alone, with
the same task, model and $3 cap. Claude Code's smoke run was not touched.

## Outcome (17 Nov 2026, 10:03 UTC): stopped after the smoke

Both smoke arms reached their $3 cap before finishing the task, so by the projection fixed above the full run does
not fit the $40 cap and was not started. The three rules were not tested. See `SMOKE.md` for the numbers and
`smoke-records.jsonl` for the records (keys and transcripts left out).
