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
- Results, with every run's record and transcript, will be published here and on relayevals.com, losses included.

Anyone will be able to re-run each test on their own API key with one command. The cheapest test is planned to cost
about $30 to repeat.

relay-bench is built and maintained by Relay. Questions: arnav@relayevals.com.

Released under the [MIT License](LICENSE).
