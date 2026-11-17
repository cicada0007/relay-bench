# Gate 2c on Bedrock: the smoke, and why the full run did not start

17 Nov 2026. One long task (node-build-runner), both arms, `qwen.qwen3-coder-next` on Amazon Bedrock (bedrock-mantle),
a $3 meter cap on each run. Setup and rule: README.md. Records: smoke-records.jsonl.

## Numbers

| | Relay 0.6.132 | Claude Code 2.1.300 |
|---|---|---|
| Requirements met | 0 of 6 | 0 of 6 |
| Said done | no | no |
| Time in the sandbox | 20.7 min | 14.7 min |
| Model spend (metered) | $3.01, cap reached | $3.02, cap reached |
| Model calls (priced / refused at the cap) | 223 / 9 | 87 / 11 |
| Prompt tokens / output tokens | 5.92 M / 39 K | 5.96 M / 29 K |
| Prompt tokens read from cache | 0 | 0 |
| Where it stopped | 1 of 6 planned tasks verified (partly proven, D-115), 5 queued; exit 3 | 103 turns; last answer "API Error ... 429 ... spend cap of 3" |
| E2B (work and judge sandboxes) | about $0.06 | about $0.04 |

Neither result says anything about either tool's quality: both were cut off at about a fifth to a third of the
time the same task took in November.

## The projection

Fixed before the smoke (README.md): 12 tasks x (Relay $ + Claude Code $), plus 30%, must fit $40.

- Model: 12 x ($3.01 + $3.02) = **$72.30 at the least** (both runs were capped, so this is a floor). With 30%: $94.
  The cap is $40. **Does not fit.**
- E2B: 12 x $0.10 = $1.25, with 30% $1.63. The cap is $10. Fits.

So the full 24 runs were not started.

## Why it costs this much

- **No prompt cache.** Mantle reports no cached tokens for this model (checked with two identical 3,000-token
  requests before the smoke, and 0 of 11.9 M prompt tokens in the smoke). Every prompt token is billed at $0.50 a
  million. In November, on gpt-6-luna, 95 to 97% of prompt tokens were cached at a tenth of the input price.
- **Agents resend their context every call.** Claude Code's mean prompt was 68,500 tokens a call (largest 111,000),
  so each call cost about $0.035; it spent $0.24 a minute. Relay spent $0.15 a minute.
- **A rough uncapped figure** (spend rate x November's times on the same 12 tasks, 6.1 h Claude Code and 12.7 h
  Relay): about $90 for Claude Code and $110 for Relay, about $200 for the gate. This is arithmetic on one capped
  task, not a measurement; qwen's speed and turn count differ from gpt-6-luna's.

## What the smoke did show

- `qwen.qwen3-coder-next` drives both harnesses: tool calls work, Claude Code ran 103 turns through the meter's
  Messages translation, and Relay planned the request into 6 tasks, worked, checked and verified one. The fallback
  model (Kimi K3.1) was not needed and not tried.
- Relay 0.6.132 refuses `relay queue run` on a machine that never signed in ("Sign in to Relay first", D-81). The
  bench sets `RELAY_SIGN_IN_FIRST=0` (README amendment 1). The refused run cost $0.005 and is not counted.
- Relay's own requirement checks on its one verified task said "not checked: the diff doesn't show ..." for 5 of 8
  requirements, and its request check named two unmet parts. The task was recorded partly proven, as D-115 says.

## Comparability notes

- Claude Code reaches Bedrock through the meter's Messages-to-Chat-Completions translation (meter/anthropic-chat.mjs);
  Relay speaks Chat Completions itself. Neither got cache reads, so the translator's cache handling made no difference
  to cost here.
- No E2B stream dropped; no run was re-run except the voided sign-in refusal.
- One run per arm, one task. Both arms ended at the same cap.

## Spend

| | Spent | Cap |
|---|---|---|
| Bedrock (meter) | $6.03 in runs, plus under $0.01 of probe calls | $40 |
| E2B | about $0.11 (runs plus one install check) | $10 |

## What would let the gate run

Any one of: a cap of about $200 on this model; a Bedrock model that bills cached prompt tokens at a discount; or the
OpenAI route of the plan (gpt-6-luna with its cache), which cost $19.43 for both arms in November.
