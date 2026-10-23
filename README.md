# relay-bench

An open benchmark of [Relay](https://relayevals.com), a coding-agent harness built by Relay, against the tools people
use directly: Claude Code, Codex, Hermes and Prime Agent, each on the same model as Relay.

**Status:** round 1 is complete. Its numbers are in [results/](results/) and on
[relayevals.com/ai-coding-agent-benchmark](https://relayevals.com/ai-coding-agent-benchmark).

- [PREREGISTRATION.md](PREREGISTRATION.md) fixes the tests, measures, statistics and the words we may use about the
  results, before the first paid run. Its commit date is the record.
- Tasks, hidden judges, the runner and the cost meter arrive here as they are built.
- [GATE.md](GATE.md) fixes how a new Relay release is judged against the current one; [ledger/ledger.json](ledger/ledger.json)
  holds every release that passed it on the exam, numbers only.
- [scripts/model-watch.mjs](scripts/model-watch.mjs) examines a new model on the exam before Relay routes to it (GATE.md,
  amendment 3); a dry run unless given a spend cap.
- [loop/](loop/) is the improvement loop: every week it proposes changes to Relay, one lane each, pre-screens them and
  writes one release for a person to open; TIERS.md says what it may see and never change.
- [AUTOPILOT.md](AUTOPILOT.md): `node loop/autopilot.mjs` carries the week's cycle to one pull request in the harness,
  only after the gate on the exam passes; a person's merge is the one step per release.
- [teaching/](teaching/) turns lessons many machines chose to share into skill candidates, which reach Relay only
  through the loop and the gate; [TEACHING.md](TEACHING.md) has the rules, and that training data is never collected
  by default.
- Results, with every run's record and transcript, will be published here and on relayevals.com, losses included.

Anyone will be able to re-run each test on their own API key with one command. The cheapest test is planned to cost
about $30 to repeat.

relay-bench is built and maintained by Relay. Questions: arnav@relayevals.com.

Released under the [MIT License](LICENSE).
