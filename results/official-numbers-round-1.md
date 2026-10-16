# Official public numbers for round 1's public benchmarks

PREREGISTRATION.md, "Honesty notes": where our run of another tool scores below that tool's own official public
number **on the same benchmark and model**, the results table shows the official number and says so. This file records
which official numbers exist for tests F and G on Claude Haiku 5.5 (`claude-haiku-5-5`), checked on 17 October 2026.

**Finding: none exists.** No publisher (the benchmark's own leaderboard, Anthropic, Harbor, Prime Intellect, or the
benchmark's authors) has published a number for Claude Code or Prime Agent with Claude Haiku 5.5 on Terminal-Bench 2.1,
OOLONG (synth, yahoo, 128k) or LongBench v2. So the rule does not apply to any row in round 1, and the results table
shows our numbers alone. The closest published numbers are listed below so a reader can see why each is not comparable.

## Table

| Benchmark | Tool | Model | Official number and source | Our number (round 1) | Comparable? |
| --- | --- | --- | --- | --- | --- |
| Terminal-Bench 2.1 (Harbor) | Claude Code | Haiku 5.5 | None. The official 2.1 leaderboard (tbench.ai, 18 entries) has no Haiku model at all. | 84.1% solved (82 trials, 1 per task so far; in progress) | No: no same-model number exists |
| Terminal-Bench 2.1 (Harbor) | Relay | Haiku 5.5 | None (Relay has never been submitted). | 72.3% solved (83 trials; in progress) | No: no number exists |
| OOLONG-synth, yahoo, 128k | Claude Code | Haiku 5.5 | None. Prime Agent's table reports Claude Code only with Opus 5 (high): 0.920. | 2.0% (50 items) | No: different model |
| OOLONG-synth, yahoo, 128k | Prime Agent | Haiku 5.5 | None. Prime Agent's table reports 0.700 (GLM-5.2 high), 0.900 (Opus 5 high), 0.940 (GPT-5.6 Sol high). | 6.0% (50 items) | No: different models |
| OOLONG-synth, yahoo, 128k | Relay | Haiku 5.5 | None. | 10.0% (50 items) | No: no number exists |
| LongBench v2 | Claude Code | Haiku 5.5 | None. Prime Agent's table reports Claude Code only with Opus 5 (high): 0.746. | 60.0% (50 of 503 questions) | No: different model and a 50-question sample |
| LongBench v2 | Prime Agent | Haiku 5.5 | None. Prime Agent's table reports 0.680 (GLM-5.2), 0.744 (Opus 5), 0.714 (GPT-5.6 Sol). | 58.0% (50 of 503 questions) | No: different models and a 50-question sample |
| LongBench v2 | Relay | Haiku 5.5 | None. | 60.0% (50 of 503 questions) | No: no number exists |

Our numbers were read on 17 October 2026 with Node 22:
`node runner/tb21-analyze.mjs --out runs/round-1` (test F, still running: 2 of 89 tasks dropped for every tool after
infrastructure failed twice, `qemu-alpine-ssh` and `qemu-startup`; the second trial per task has not run) and
`node runner/longctx-analyze.mjs --out runs/round-1 --test G`.

## What was checked, source by source

### Test F: Terminal-Bench 2.1

- **tbench.ai, Terminal-Bench 2.1 leaderboard**, https://www.tbench.ai/leaderboard/terminal-bench/2.1 (read
  17 Oct 2026). 18 entries; the Claude entries are Fable 5, Opus 4.8, Sonnet 5, Opus 4.7 (Claude Code or Terminus 2),
  and GLM-5.1 in Claude Code. No Haiku model of any version. Filtering by `?models=Claude+Haiku+5.5` returns the same
  unfiltered list. Leaderboard submissions use `harbor run -d terminal-bench/terminal-bench-2-1 ... -k 5`
  (https://github.com/harbor-framework/terminal-bench-2-1), so even a future entry would be 5 trials per task against
  our 2.
- **Anthropic, "Introducing Claude Haiku 5.5"** (7 Oct 2026), https://www.anthropic.com/claude-haiku-5-5, and the
  **Claude Haiku 5.5 System Card**,
  https://www-cdn.anthropic.com/e1080d6bf5ae2018ea3c2f414064be03232f5be5/Claude%20Haiku%205.5%20System%20Card.pdf.
  Anthropic reports **Terminal-Bench 4.0**, not 2.1: Haiku 5.5 **39.2%**, Claude Code in `--bare` mode at max effort,
  10 trials per task (660 trials), no internet egress, safeguards on. The system card's capability sections cover
  Terminal-Bench 4.0 and Terminal-Bench-Science 0.1 only. Not comparable: a different benchmark version and task set.
- **tbench.ai main leaderboard** (now Terminal-Bench 4.0), https://www.tbench.ai/leaderboard: no Haiku 5.5 entry; not
  the benchmark we run in any case.
- **Harbor**: publishes the runner and the dataset (we pin Harbor 0.24.0 and `terminal-bench/terminal-bench-2-1`
  revision 6); its published results are the tbench.ai leaderboard above. No separate Haiku 5.5 number found.
- Third-party, not official, for context only: Vals AI's Terminal-Bench 2.1 page
  (https://www.vals.ai/benchmarks/terminal-bench-2-1, updated 28 Sep 2026) lists Haiku 4.5, not Haiku 5.5, and runs its
  own harness (Terminus 2), not Claude Code.

### Test G: OOLONG and LongBench v2

- **Prime Intellect, "Prime Agent: A self-improving RLM agent"** (5 Aug 2026),
  https://www.primeintellect.ai/blog/prime-agent, "Long context and long-running tasks" table. Models and harnesses:
  GLM-5.2 (high) in Prime Agent and Pi-mono; Opus 5 (high) in Prime Agent and Claude Code; GPT-5.6 Sol (high) in Prime
  Agent and Codex. The main context is offloaded to a file, as in our runner. Rows we use:

  | Eval | GLM-5.2 Prime Agent | GLM-5.2 Pi-mono | Opus 5 Prime Agent | Opus 5 Claude Code | GPT-5.6 Sol Prime Agent | GPT-5.6 Sol Codex |
  | --- | --- | --- | --- | --- | --- | --- |
  | OOLONG (yahoo, 128k) | 0.700 | 0.420 | 0.900 | 0.920 | 0.940 | 0.500 |
  | LongBenchv2 | 0.680 | 0.696 | 0.744 | 0.746 | 0.714 | 0.704 |

  No Haiku model. The post does not state the sample size or which LongBench v2 questions were run. Not comparable.
- **OOLONG paper**, Bertsch et al., "Oolong: Evaluating Long Context Reasoning and Aggregation Capabilities",
  https://arxiv.org/abs/2511.02817 (v1 4 Nov 2025, v2 5 Oct 2026, two days before Haiku 5.5 was released). Bare models,
  no agent harness. The only Claude model in its results tables is Claude-Sonnet-4 (OOLONG-synth, 128k: 0.48). No
  Haiku. The repository (https://github.com/abertsch72/oolong) has no leaderboard.
- **LongBench v2 leaderboard**, https://longbench2.github.io/ (latest entry 6 May 2025). Bare models; no Haiku 5.5, and
  no agent harness. Not comparable.
- **Anthropic** (launch post and system card above): no OOLONG or LongBench v2 number for Haiku 5.5; the system card's
  long-context section reports ProgramBench only.

## Notes for the results page

- Because no same-model official number exists, the rule produces no row. The page can say so in one line and link
  here, so a reader sees the check was made.
- On OOLONG our Haiku 5.5 numbers (2% to 10%) are far below every number in Prime Agent's table (42% to 94% on
  stronger models). The rule does not apply across models, but the gap is large enough that the page should state
  the model difference plainly next to Prime Agent's table rather than leave readers to compare the two. Our Prime
  Agent runs on Haiku 5.5 also run without thinking (amendment 2), which Prime Intellect's runs did not.
- Re-check before publishing: tbench.ai's 2.1 leaderboard or Prime Intellect could add a Haiku 5.5 entry before the
  round ends.
