# Teaching

v7 step 5: a lesson that many machines proved becomes a skill every Relay ships, and only through the same gate as
every other change to Relay. **Not yet run.** Everything here is tested on made-up data only: no machine has shared a
lesson, the receiver is not deployed, and no candidate has been through the loop.

Relay learns on each machine (harness D-90): refine writes lessons, the local gate lets them in, and a lesson that is not
used in a task that passes its checks expires after 28 days. Teaching has three parts, each built behind switches that
are off by default:

| Part | Where | What it does |
| --- | --- | --- |
| Sharing | the harness (D-94) | a person can choose to share proven lessons; nothing leaves the machine without that opt-in |
| The receiver | relayevals.com | an authenticated, opt-in-only API that keeps shared lessons; built, not deployed |
| Graduation | this repository, `teaching/` | groups lessons from many machines into skill candidates for the improvement loop |

## What a machine shares

A lesson qualifies on the machine only when it is accepted (live through the local gate, or kept by the person; never
held or refused), not tainted, and used in at least 3 tasks that passed their checks. Its words are redacted first, and
the lesson is refused when the machine is unsure it holds no secret, path or name (harness D-94). A skill entry in the
store is Python code and is never shared.

What reaches the receiver, exactly, is one batch:

```json
{
  "consent": "lessons-v1",
  "machine": "m_<32 hex>",
  "lessons": [
    { "kind": "prompt | memory | subagent", "title": "...", "text": "...", "model": "provider/id or unknown", "passes": 4 }
  ]
}
```

- `consent` names the words the person agreed to. A batch under any other consent is not read.
- `machine` is an id made for sharing only: not the machine's installation id, not its usage-count id, not the account.
  It lets graduation count independent machines and nothing else.
- `title` and `text` are the lesson's words after redaction, `kind` its kind, `model` the model that wrote it, and
  `passes` how many tasks that used it then passed their checks on that machine.

Never the session, the code, the repository's name, the task or the person. The receiver is authenticated, so it knows
which account sent a batch. It keeps that only to rate-limit and to delete a person's lessons when they ask;
graduation never reads it. A receiver's export, one record per line, has the same fields with the machine on each:
`{ "machine", "kind", "title", "text", "model", "passes" }`.

## Graduation

`teaching/graduate.mjs` reads shared lessons (batch files, or record lines; the receiver comes later, so tests use
files) and writes skill candidates:

```
node teaching/graduate.mjs <files or folders>... [--min-machines 5] [--min-passes 25] [--out runs/teaching] [--json]
```

1. **Checked again.** Every batch and record is validated strictly against the format above, and anything that fails is
   skipped and counted by reason: a malformed one, one not under consent `lessons-v1`, a field the format does not have,
   and any lesson whose words still hold a secret, a path, an email or a link. The machine already refused those; this
   is the same check on Central's side, and it skips, never redacts.
2. **Near-duplicates are grouped.** Two lessons are the same lesson when they are of the same kind, both or neither say
   "not" (or never, no, don't, avoid, without), and their words overlap by **0.6 or more**: Jaccard similarity over the
   sets of words in title and text, lowercased, with punctuation, placeholders such as `<path>`, and common words such
   as "the" and "you" removed, and each word cut to its stem ("committing" and "commit" are one word). Groups are
   transitive: a lesson like one in a group joins it.
3. **The rule.** A group becomes a candidate only with at least **M = 5 independent machines** (distinct machine ids)
   and at least **K = 25 passing uses**. Passing uses are summed over machines, each counting once with the highest
   `passes` it sent in the group, so a machine that sends a lesson many times, or again with more passes, adds nothing
   past its best.
4. **A skill candidate**, in the harness's skill format (Agent Skills, as `core/skills.ts` loads it):
   `<out>/<name>/SKILL.md` with the frontmatter `name` (the folder's name: lowercase letters, digits and single
   hyphens, at most 64 characters, from the lesson's title) and `description` (its title, and its first sentence when
   the title is short), then the lesson's words; and `<out>/<name>/candidate.json` with the evidence: machines, passing
   uses, copies, the models that wrote it, the hash of every version of its words, the thresholds used, and the hash of
   its SKILL.md. The words are those the most machines sent. The output is the same, byte for byte, for the same input.

A candidate is never accepted here: it has no field that could say so, the script refuses to write into a harness
checkout, and it opens nothing anywhere.

## From candidate to base skill: only through the loop and the gate

A candidate becomes a base skill only through the improvement loop's prompts and skills lane and the gate (`loop/`,
`runner/gate.mjs`, GATE.md), never directly:

```
node loop/cycle.mjs --records ... --harness ../prime-agent-main --champion 0.6.121 --teaching runs/teaching
```

- Each candidate is one prompts-and-skills proposal that adds `packages/coding-agent/skills/<name>/SKILL.md` as a new
  file. No model writes it, so it costs nothing and needs no cap; it takes the lane's one slot like a written change
  would, heaviest evidence first.
- It is checked like every proposal, from the change itself: the lane lets a new skill add only its SKILL.md, whole, as
  a new file, with a name the harness loads and that no shipped skill has; every invariant applies (a skill whose path
  reaches a grader's, for one); its words are checked again for secrets, paths, emails and links, and it is refused
  when it names a task or anything else from the practice failures the cycle studied.
- Then it is pre-screened, packaged and gated on the exam with the rest of the release, and a founder signs it. Applying
  it is `git apply` and `npm run arch`, which lists the new skill in relay.arch with its hash.
- Teaching's own rules (`teaching/`, this file) and the machine's sharing code (`core/teaching/`) are invariants: no lane
  and not the meta loop may change them.

## Skill packs

The harness's `relay skills pack <name>` builds a skill pack from accepted skills: Agent Skills folders, one SKILL.md
with its name and description each, beside a manifest (harness D-94 has the format). Any agent that reads Agent Skills
can load them. A taught skill, once the gate has let it in, ships and packs like any other base skill.

## Training data

**Document only.** Nothing in Relay today exports trajectories, and nothing in this build does.

- Training data from Relay sessions (conversations, tool calls, code, diffs, task records) is **never collected by
  default**, and is not collected under the lesson-sharing opt-in or any other.
- Collecting any would need its own written opt-in: its own words and its own version, agreed to and signed by the
  person, and revocable at any time, with what was collected deleted when it is revoked.
- That opt-in would say exactly what is collected (which trajectories, from which tasks, and with what redaction), what
  it is for, who can read it, and how long it is kept.
- Until a founder writes those words and a person agrees to them, there is nothing to collect and no code that could.

## Not done

- The receiver is built but not deployed, and no real lesson has been shared or graduated.
- M = 5, K = 25 and the 0.6 similarity are starting choices, not measured ones.
- `passes` is what each machine reports. A person who changes their own Relay could report more; the rule's independent
  machines, the receiver's per-account limit and the gate are what stand against that.
- Near-duplicates are found by shared words, not meaning, and every pair is compared, which is fine for thousands of
  lessons and not for millions.
