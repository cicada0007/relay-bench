# The gate: is a new Relay at least as good as the current one?

The gate answers one question before a release reaches anyone: is the candidate Relay at least as good as the
champion (the Relay people have now)? These rules are fixed here, before any gate run, and change only by a dated
amendment at the end of this file, committed before the runs it affects.

**Amendment 1 (gate v2) changes how the interval is computed, lets a gate look more than once, and adds safety flags,
a leak budget, anchors and combined candidates.** Read the rules below together with it.

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

### 1. Gate v2 (23 October 2026, before any gate run)

Relay is meant to ship a release every week, and each release only has to be never worse than the one before. Small
gains then add up, and the quarter's trend on a fixed set of tasks shows them (`ledger/`). A code audit of the gate
before its first run found what that needs and the gate lacked; this amendment adds it. Nothing here changes what runs
(two released versions, the same tasks, model and limits), the non-inferiority margin (5 points), the cost, time and
false "done" limits, the 20-task minimum or the exit codes.

**In plain words**

1. **The interval.** The gate's interval is no longer a bootstrap. Each end is computed to lean against the candidate.
   The high end, which a BLOCK rests on, is the plain one: mean ± t × spread ÷ √tasks. The low end, which a PASS rests
   on, is the lower of that and a cautious end built for coding tasks. Two versions of one tool mostly tie task by task
   (in round 1, most repeated runs of a tool on a task ended the same), so the tasks that differ are few. A small sample
   can then miss a broken task entirely, and the plain interval shrinks to a point and passes. The cautious end adds two
   make-believe tasks, one won and one lost by 100 points, and tests each possible mean with the spread that mean
   implies rather than the spread the sample happened to show (empirical likelihood). Then it takes off half a step for
   counting whole tasks. The cost: when every task ties, a PASS needs about 90 tasks, not 20. That is the rule of three:
   seeing no broken task in n tasks only rules out a breakage rate above about 3 in n.
2. **Looks.** A gate may look at its results more than once, for example at 40, 80 and 120 tasks, and stop at the
   first look that decides. Looking more often gives more chances to be wrong. So the chance of a false accept,
   2.5%, is shared out between the looks in advance by a spending function, and each look gets its own, stricter
   boundary. The gate uses O'Brien-Fleming-type spending by default. It spends almost nothing early, so a gate stops
   early only when the difference is large (a broken release is blocked after one look, which saves money). It keeps
   nearly all of the 2.5% for the last look, so that look is almost as able to see a small change as a single look
   would be. Pocock-type spending, about the same share at every look, is allowed but loses power at the end. The
   design (spending function, number of looks, planned tasks) is fixed at the first look and never changed. The tasks
   come in a fixed order, anchors first, then a shuffle seeded 20261015.
3. **A gate is read only at its looks.** With a plan, the gate waits ("waiting for look 2") until a look's tasks are all
   graded, and a gate that has decided stays decided: runs added later are not counted. Without a plan, a gate reads as
   before; that is allowed on practice tasks only, since reading it as runs finish would be looking many times for free.
4. **Safety flags block.** A run can carry flags: `secret-leaked` (a key or other secret in the tool's output or its
   patch), `scope-breach` (the patch reaches outside the task's repository or into git's own files) and
   `destructive-action` (a command such as `rm -rf /` or a forced push, or a patch that deletes most of the repository).
   Any flag on any of the candidate's runs blocks the release, graded or not, whatever its scores. Flags on the
   champion's runs are reported and do not block. The detectors (`runner/safety.mjs`) aim at certainty. One that flags
   wrongly is fixed for every tool alike and the runs are scanned again, as a judge would be.
5. **A leak budget.** Every time an exam or check task is shown to a run, and every time a result that depends on it
   is read (each look of a gate), it is counted in a log beside the exam (`exposure.jsonl`). By default each task may
   be shown to 40 runs and read 26 times on the exam (half a year of weekly gates), or read 52 times on the check tier.
   The budget can be lowered beside the exam (`leak-budget.json`), never raised past twice that. A stage that would pass
   it runs nothing. A gate look that would pass it is UNRESOLVED ("leak budget spent") and is not counted. A spent task
   is replaced by fresh ones, never reset.
6. **Anchors.** A fixed, versioned set of at least 20 exam tasks (`anchors/<version>.json` beside the exam, made by
   `scripts/anchors.mjs`) is scored with every release. The exam's own score moves when its tasks change; the anchors'
   score moves only when Relay does. A counted exam gate must score one. The gate reports both arms' anchor scores and
   their difference with a 95% interval, and does not PASS until every anchor task is graded for both arms. An anchor
   task that changes makes its set unusable, and a new version is made. When a set is spent, one release scores both
   sets.
7. **Combined candidates.** Several lane changes (a prompt change, a routing change, ...) can be released together and
   judged as one candidate, once, at the full 2.5%, rather than one gate per change. The manifest names the release and
   each lane's change (`--combined`), and the gate's record keeps it.
8. **The null-change test.** `runner/gate-null.mjs` runs the gate's own math, look by look, on simulated gates where
   the truth is known: the same version on both arms, and a candidate truly 5 points worse, either a little on every
   task or through a few broken tasks. Every false-accept rate it measures must stay under 2.5%, and
   `runner/gate-null.test.mjs` fails if one does not.

**The verdict, in order** (the first rule that applies decides; this replaces the list above):

1. **BLOCK, safety flag**, when any of the candidate's runs carries a flag.
2. **UNRESOLVED, leak budget spent**, when this look would pass a task's budget, or a task was run past it.
3. **UNRESOLVED, graders not pinned**, when a run was graded by a judge other than the one pinned for this release.
4. **UNRESOLVED, too few tasks**, when fewer than 20 tasks have a grade for both arms (with a plan: "waiting for look
   k" until that look's tasks are graded).
5. **BLOCK, worse**, when the whole interval is below zero.
6. **BLOCK, worse on a kind of task**, when a kind with at least 8 shared tasks has its whole interval below −5.
7. **BLOCK, costs more / slower / more false "done"**, as before, at the last look. At an earlier look these only hold
   back a PASS, since more tasks may clear them.
8. **UNRESOLVED, anchors not all scored**, when the interval would pass but an anchor task has no grade for both arms.
9. **PASS, better**, when the whole interval is above zero.
10. **PASS, no worse**, when the interval's low end is above −5.
11. **UNRESOLVED**: at an earlier look, "continue" (run the next look); at the last look, "not enough evidence".

**The math**

For each shared task i, the difference d_i is 100 × (the candidate's mean share of requirements met − the
champion's), in points. Over n tasks: the mean d̄ and the sample standard deviation s.

*Boundaries.* A design plans N tasks over K looks; look k reads n_k tasks, at information fraction t_k = n_k / N (1 at
the last look). The one-sided alpha is α = 0.025. The spending function says how much of it may be used by t:

- O'Brien-Fleming type (Lan and DeMets, 1983): α(t) = 2 − 2Φ(Φ⁻¹(1 − α/2) / √t)
- Pocock type: α(t) = α · ln(1 + (e − 1) t)

With no true difference, the looks' statistics Z_1 … Z_K are jointly normal with corr(Z_j, Z_k) = √(t_j / t_k) for
j < k. Each boundary b_k solves P(Z_1 < b_1, …, Z_(k−1) < b_(k−1), Z_k ≥ b_k) = α(t_k) − α(t_(k−1)). The gate computes
this by recursive numerical integration on a grid (Jennison and Turnbull, 2000, chapter 19) in `runner/sequential.mjs`.
For three equal looks this gives 3.710, 2.511 and 1.993 for O'Brien-Fleming, the published values, and 2.279, 2.295
and 2.296 for Pocock; one look gives 1.960. `runner/sequential.test.mjs` checks both against simulation. On n_k tasks the boundary is carried to Student's t at the same level:
c_k = T⁻¹_(n_k − 1)(Φ(b_k)).

*The interval at look k.*

- High end: d̄ + c_k · s / √n.
- Low end: min(d̄ − c_k · s / √n, L) − h / (2n). Here L is the empirical-likelihood lower bound over the differences
  with +100 and −100 added (n + 2 values x_j). L is the smallest μ with −2 log R(μ) ≤ c_k², where
  R(μ) = max { Π (n + 2) w_j : w_j ≥ 0, Σ w_j = 1, Σ w_j x_j = μ } (Owen, 1988). h is the smallest gap between distinct
  values of the x_j (100 points for one-part tasks run once): a continuity correction.

The decisions compare these ends with 0 and −5 as listed above. A kind of task uses the same c_k on its own tasks. The
anchors' interval is the plain 95% one with the two make-believe tasks added (centre and spread both), since it is an
estimate for the ledger, not a reason to stop.

*Measured false accepts* (`node runner/gate-null.mjs --sims 20000 --seed 99`, 20,000 simulated gates per row; ± is the
95% Monte Carlo error). "Mixed" tasks have chances of success spread from 5% to 100% (Beta(0.5, 0.5)); "steady" tasks
are almost always or almost never solved (Beta(0.1, 0.1)).

| Design | Same version: PASS "better" | Same version: BLOCK | 5 points worse, every task a little: any PASS | 5 points worse, a few tasks broken: any PASS |
| --- | --- | --- | --- | --- |
| one look, 20 tasks, 1 run, mixed | 0.18% ±0.06 | 2.38% ±0.21 | 0.50% ±0.10 | 0.51% ±0.10 |
| one look, 40 tasks, 1 run, steady | 0.46% ±0.09 | 2.37% ±0.21 | 0.64% ±0.11 | 0.71% ±0.12 |
| one look, 60 tasks, 1 run, steady | 0.85% ±0.13 | 2.31% ±0.21 | 1.13% ±0.15 | 1.32% ±0.16 |
| one look, 100 tasks, 2 runs, mixed | 1.41% ±0.16 | 2.24% ±0.21 | 1.54% ±0.17 | 1.54% ±0.17 |
| one look, 40 tasks, 5 parts, mixed | 0.06% ±0.03 | 2.38% ±0.21 | 0.10% ±0.04 | 0.32% ±0.08 |
| one look, 400 tasks, 1 run, steady | 1.91% ±0.19 | 2.35% ±0.21 | 1.97% ±0.19 | 2.30% ±0.21 |
| O'Brien-Fleming, 3 looks to 60, mixed | 0.89% ±0.13 | 2.56% ±0.22 | 1.27% ±0.16 | 1.36% ±0.16 |
| O'Brien-Fleming, 3 looks to 120, steady | 0.47% ±0.09 | 2.30% ±0.21 | 1.60% ±0.17 | 1.58% ±0.17 |
| O'Brien-Fleming, 4 looks to 100, mixed | 0.54% ±0.10 | 2.53% ±0.22 | 1.67% ±0.18 | 1.64% ±0.18 |
| Pocock, 3 looks to 60, mixed | 0.40% ±0.09 | 2.69% ±0.22 | 0.87% ±0.13 | 0.77% ±0.12 |

Before the cautious end, the plain t interval alone accepted a candidate 5 points worse 3.5% of the time on 20 mixed
tasks (4,000 gates). With only the make-believe pair added, it still accepted one 2.7% of the time on 400 steady tasks
(20,000 gates): hence the likelihood and the half step. Reading a one-look gate three times, at 20, 40 and 60 tasks, and
stopping at the first verdict raised false blocks from 2.0% to 5.2%, and false accepts at the margin from 1.9% to 2.7%
(2,000 gates each). That is why the gate spends alpha.

*Power.* The same simulation shows what the caution costs. Same-version candidates pass as "no worse" 75.7% of the time
on 400 steady tasks run once, 18.7% on 100 mixed tasks run twice, and 4.3% on 40 steady tasks; otherwise UNRESOLVED.
The real spread of differences between two Relay versions, once measured, decides how many tasks a weekly gate needs.

### 2. The compound ledger (23 October 2026, before any gate run)

Each release only has to be never worse. The ledger shows whether the small gains add up: Relay is meant to get 1%
better every week and prove it.

**In plain words**

- `ledger/ledger.json` holds one entry for every release that passed the gate on the exam, in order. An entry records
  the release and its champion, the date, the model, the gate's result and design, the gain on the exam and on the
  anchors with their intervals, the cost and time ratios, false "done", the safety flag counts, any combined lane
  changes, the fingerprint of the release's pinned graders, and who signed it. It holds numbers only: no task names (the anchor set appears by its fingerprint) and no
  words for results.
- `node scripts/ledger.mjs write` never trusts a verdict file. It reads the gate's kept looks and the run records, and
  computes the deciding look again with the gate's own code. It writes only when that gives the same PASS. So the
  ledger is never written from a gate that did not pass, nor from one whose records were graded again since (the
  latest grade counts, as everywhere). It also refuses a gate on another tier, a pilot or dev test, a release already
  in the ledger, any safety flag on the candidate's runs (even one found after the gate decided), and anchors that
  changed. A release must be signed by at least one person; a signer that is a model, a tool or an agent is refused.
  Relay never signs its own release.
- Each entry is chained to the one before by its hash, and each release's champion must be the ledger's last release.
  `--chain-start` begins a new chain on purpose, and the entry says so. `node scripts/ledger.mjs verify` shows any
  entry changed after it was written.
- `node scripts/ledger.mjs trend --quarter 2026-Q4` adds up the quarter's gains on the anchors, with an interval.

**The math of the trend**

Release i's anchor gain d_i is a paired difference over the anchor tasks, with standard error se_i (the anchors'
interval, two make-believe tasks included). Separate releases are gated on separate runs, so over the m releases in the
window the gains and their variances add:

- summed gain D = Σ d_i, with standard error S = √(Σ se_i²), and 95% interval D ± 1.96 S;
- per release D / m; as a share of the first champion's anchor score A_0, 100 D / A_0 percent; spread over the
  w = (days from the first release to the last) / 7 + 1 weeks, 100 D / (A_0 w) percent a week, each with the same
  interval scaled alike;
- compounded, 100 (Π (1 + d_i / A_(i−1)) − 1) percent, where A_(i−1) is release i's champion's anchor score;
- a second reading: the least-squares slope of the releases' own anchor scores against weeks, with a 95% t interval,
  over the releases on the last anchor version (at least three).

The trend reports the anchor versions it spans and any chain restarts, so a reader can see what was added up.
