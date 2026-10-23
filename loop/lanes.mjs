// The improvement loop's lanes and its invariants (v7: Central's improvement loop, Meta's invariants).
//
// A lane is one kind of change to Relay. Each lane may touch only its own part of relay.arch (D-91, the harness's
// architecture as code) and the source files that part names, so a proposal says which lane it is in and the loop checks
// that it stays there. The invariants are what no lane, and not the meta loop, may ever change: the release's ceilings,
// the trusted core, the exam's contents and approval, the graders, the gate's rules, tenant data, and the human
// signature. A proposal that reaches one is refused with the reason, before anything is spent on it.
//
// Every check here is computed from the change itself (the JSON paths it changes in relay.arch, the files its patch
// touches), never from what the proposal says about itself.
import { patchPaths } from "../runner/safety.mjs";
import { getPath, globToRegExp, hunkRanges, under } from "./diff.mjs";

/** The lanes, in the order a cycle runs them and a release lists them. */
export const LANE_ORDER = Object.freeze(["config", "routing", "memory", "tools", "prompts", "architecture", "exam", "runtime"]);

/**
 * What each lane is. `how`: "rules" (the loop proposes from its own table, free), "writer" (a model writes the change,
 * paid), "queue" (new exam task candidates for people to approve) or "later" (documented, never run). `arch`: the
 * relay.arch paths it may change. `prompt`: which relay.arch prompts a writer lane may edit, by id.
 */
export const LANES = Object.freeze({
	config: {
		label: "config",
		how: "rules",
		words: "the queue's own limits: attempts, what counts as stuck, the request check, a plan's size, turns per attempt",
		decisions: ["D-11", "D-17", "D-43", "D-47", "D-75"],
		arch: ["queue.stuck", "queue.requestCheck", "queue.maxAttempts", "queue.maxRecoveries", "queue.plan", "budgets.turnsPerAttempt", "checks.inSessionRetries", "checks.gateTimeoutMinutes"],
	},
	routing: {
		label: "routing",
		how: "rules",
		words: "which tier and model works a task: the tiers' model lists, the suitability table, the Decider's share",
		decisions: ["D-46", "D-60", "D-61"],
		arch: ["routing.tiers", "routing.suitability", "routing.deciderShare", "routing.refusalHoldHours"],
	},
	memory: {
		label: "memory",
		how: "rules",
		words: "how Relay learns between sessions: automatic refine's rhythm and the learning mode",
		decisions: ["D-56", "D-90"],
		arch: ["memory.autoRefine", "memory.learningMode"],
	},
	tools: {
		label: "tools",
		how: "writer",
		words: "the tools as the model sees them: their descriptions and parameters",
		decisions: ["D-48"],
		arch: ["tools"],
		prompt: (id) => id.startsWith("tool."),
	},
	prompts: {
		label: "prompts and skills",
		how: "writer",
		words: "the prompts Relay sends and the skills it ships",
		decisions: ["D-47", "D-74", "D-75"],
		arch: ["prompts", "skills"],
		prompt: (id) => !id.startsWith("tool."),
		skills: true,
	},
	architecture: {
		label: "architecture",
		how: "rules",
		words: "how Relay is put together: sub-agents' depth, the tier a child runs on, the agents and their prompts",
		decisions: ["D-46", "D-60", "D-91"],
		arch: ["subAgents.maxDepth", "subAgents.childTier", "topology"],
	},
	exam: {
		label: "exam proposals",
		how: "queue",
		words: "new task candidates for the exam, queued for a person; the loop never approves one",
		decisions: [],
		arch: [],
	},
	runtime: {
		label: "runtime",
		how: "later",
		words: "where and how a task runs (the E2B sandbox's image, size and tools); documented only, not run yet",
		decisions: ["D-89"],
		arch: [],
	},
});

/** relay.arch values Relay reads from the file (D-91, "Set here"): changing one is editing relay.arch.json. */
export const SET_HERE = Object.freeze([
	"routing.tiers",
	"routing.suitability",
	"routing.deciderShare",
	"routing.refusalHoldHours",
	"subAgents.maxDepth",
	"subAgents.childTier",
	"queue.requestCheck",
	"queue.stuck",
	"selfModel.minSamples",
	"selfModel.blindSpots",
]);

/** Where the code holds the relay.arch values the generator reads from it (D-91's observe.ts), for the values a lane's
 *  rules change. A change to one is a change to that code; relay.arch.json's own diff shows the reviewer what moves. */
export const CODE_HOMES = Object.freeze({
	"queue.maxAttempts": "packages/supervisor/src/store.ts MAX_ATTEMPTS",
	"queue.maxRecoveries": "packages/supervisor/src/store.ts MAX_RECOVERIES",
	"queue.plan": "packages/supervisor/src/route.ts MAX_PLANNED_TASKS",
	"budgets.turnsPerAttempt": "packages/supervisor/src/store.ts DEFAULT_TURN_BUDGET",
	"memory.autoRefine": "packages/coding-agent/src/core/settings-manager.ts getAutoRefineSettings",
	"memory.learningMode": "packages/coding-agent/src/core/refinement/learning-mode.ts DEFAULT_LEARNING_MODE",
});

/** The paths of relay.arch marked "Set here" in its schema (relay.arch.schema.json), to check SET_HERE against it. */
export function setHereFromSchema(schema) {
	const found = [];
	const walk = (node, path) => {
		if (!node || typeof node !== "object") return;
		if (typeof node.description === "string" && /^Set here\b/.test(node.description) && path.length) found.push(path.join("."));
		for (const [k, child] of Object.entries(node.properties ?? {})) walk(child, [...path, k]);
	};
	walk(schema, []);
	return found.sort();
}

/**
 * The invariants: never self-modifiable (v7, "Invariants"). `arch` are relay.arch paths, `files` globs over the
 * harness's files and this benchmark's own. A proposal whose change reaches any of them is refused.
 */
export const INVARIANTS = Object.freeze([
	{
		id: "ceilings",
		words: "the release's ceilings and spend caps (cost, time, depth, egress; D-80)",
		arch: ["budgets.releaseCeilings", "budgets.firstRunSpendCap"],
		files: ["scripts/release-ceilings.json", "**/release-ceilings.generated.ts"],
	},
	{
		id: "trusted-core",
		words: "the trusted core: release signing and trust, the installer, the switch-off list, the audit log, project trust, and what a task must pass and may touch (D-09, D-10, D-78, D-80)",
		arch: ["checks.gates", "checks.scopeAllow", "checks.scopeDeny"],
		files: ["scripts/release-trust.json", "**/release-trust*", "install.sh", "scripts/publish-release*", "scripts/pack-relay-release.mjs", "scripts/release.mjs", "**/withdrawn*", "**/audit*", "**/project-trust*", "docs/signing-releases.md", "relay.policy.json"],
	},
	{
		id: "exam",
		words: "the exam's contents and approval: tasks, locks, anchors, candidates, queues and the leak budget (TIERS.md)",
		arch: [],
		files: ["tasks/**", "dev-tasks/**", "**/TASKS.lock.json", "anchors/**", "pins/**", "**/candidates.jsonl", "queue/**", "**/exposure.jsonl", "**/leak-budget.json", "scripts/approve-task.mjs", "scripts/lock-tasks.mjs", "scripts/draft-task.mjs", "scripts/mine-tasks.mjs", "scripts/contamination.mjs", "scripts/living-exam.mjs", "scripts/saturation.mjs"],
	},
	{
		id: "graders",
		words: "the graders: every judge, its pins and the hand check",
		arch: [],
		files: ["**/judge/**", "**/judge.mjs", "scripts/exam-judge/**", "runner/rejudge.mjs", "runner/pins.mjs", "scripts/pin-graders.mjs", "scripts/handcheck.mjs", "scripts/grader-agreement.mjs"],
	},
	{
		id: "gate",
		words: "the gate's rules and the human signature: GATE.md, TIERS.md, the pre-registration, the gate's code, the check tier's door, the ledger, and this loop's own rules",
		arch: [],
		files: ["GATE.md", "TIERS.md", "PREREGISTRATION.md", "runner/gate*.mjs", "runner/sequential.mjs", "runner/interval.mjs", "runner/safety.mjs", "runner/exposure.mjs", "runner/anchors.mjs", "runner/stage-tasks.mjs", "scripts/ledger.mjs", "scripts/check-query.mjs", "ledger/**", "loop/**"],
	},
	{
		id: "tenant-data",
		words: "tenant data: what leaves a machine, only with opt-in (D-72)",
		arch: [],
		files: ["**/core/counts/**", "**/telemetry*", "**/agent-traces*", "**/relay-account/**"],
	},
]);

const INVARIANT_RES = INVARIANTS.map((inv) => ({ ...inv, res: inv.files.map(globToRegExp) }));

/** Why a change reaches an invariant: [{ invariant, what }], empty when it does not. */
export function invariantHits({ arch = [], files = [] }) {
	const hits = [];
	for (const inv of INVARIANT_RES) {
		for (const p of arch) if (inv.arch.some((a) => under(p, a) || under(a, p))) hits.push({ invariant: inv.id, what: `relay.arch ${p}` });
		for (const f of files) if (inv.res.some((re) => re.test(f))) hits.push({ invariant: inv.id, what: f });
	}
	return hits;
}

/** A code home as file and symbol: "packages/supervisor/src/store.ts MAX_ATTEMPTS" -> { file, symbol }. */
export const codeHome = (path) => {
	const key = Object.keys(CODE_HOMES).find((k) => under(path, k));
	if (!key) return null;
	const [file, symbol] = CODE_HOMES[key].split(" ");
	return { file, symbol };
};

/**
 * The source a lane may change, besides relay.arch.json: [{ file, symbols }], where `symbols` are the declarations
 * whose lines it may edit (null: the whole file). A writer lane owns the prompts it is named for, by their file and
 * symbol in relay.arch, and the prompts lane each shipped skill's SKILL.md. A rules lane owns the code that holds the
 * values it may change (CODE_HOMES).
 */
export function laneScope(lane, arch) {
	const def = LANES[lane];
	const scope = new Map();
	const add = (file, symbol) => {
		if (!scope.has(file)) scope.set(file, symbol === null ? null : []);
		const symbols = scope.get(file);
		if (symbols && symbol && !symbols.includes(symbol)) symbols.push(symbol);
	};
	if (def?.prompt) for (const p of arch?.prompts ?? []) if (def.prompt(p.id)) add(p.file, p.symbol);
	if (def?.skills) for (const s of arch?.skills ?? []) add(`${s.dir}/SKILL.md`, null);
	for (const [path, home] of Object.entries(CODE_HOMES)) {
		if (def?.arch.some((a) => under(path, a))) {
			const [file, symbol] = home.split(" ");
			add(file, symbol);
		}
	}
	return [...scope].map(([file, symbols]) => ({ file, symbols }));
}

/**
 * Why a proposal cannot go forward; empty when it can. Checks, from the change alone:
 * - the lane is one the loop runs (not "runtime", which is documented only);
 * - every relay.arch path it changes is inside the lane;
 * - every other file its patch touches is one the lane owns, and every hunk lies inside a declaration the lane owns
 *   (`sources`: each touched file's text before the change, from the champion's harness);
 * - nothing reaches an invariant;
 * - no value goes past a release ceiling that is set.
 */
export function proposalProblems(proposal, { arch = null, sources = {} } = {}) {
	const problems = [];
	const def = LANES[proposal.lane];
	if (!def) return [`no lane ${proposal.lane}`];
	if (def.how === "later") problems.push(`the ${proposal.lane} lane is documented only; it proposes nothing yet`);
	if (def.how === "queue") problems.push("exam proposals go to the approval queue, never into a patch");
	const archPaths = proposal.touches?.arch ?? [];
	const files = proposal.patch ? patchPaths(proposal.patch) : [];
	for (const p of archPaths) if (!def.arch.some((a) => under(p, a))) problems.push(`relay.arch ${p} is outside the ${proposal.lane} lane`);
	const scope = new Map(laneScope(proposal.lane, arch).map((s) => [s.file, s.symbols]));
	const hunks = hunkRanges(proposal.patch);
	for (const f of files) {
		if (f === "relay.arch.json") {
			if (def.how === "writer") problems.push("a writer lane changes source, not relay.arch.json; the generator rewrites relay.arch");
			continue;
		}
		if (!scope.has(f)) {
			problems.push(`${f} is outside the ${proposal.lane} lane`);
			continue;
		}
		const symbols = scope.get(f);
		if (symbols === null) continue;
		const source = sources[f];
		if (typeof source !== "string") {
			problems.push(`${f} was not read, so its change cannot be checked`);
			continue;
		}
		const spans = symbols.map((s) => [s, symbolSpan(source, s)]).filter(([, span]) => span);
		for (const [from, to] of hunks[f] ?? []) {
			// A hunk's context lines may reach past the declaration; its changed lines may not.
			const changed = changedLines(proposal.patch, f).filter((n) => n >= from && n <= to);
			const outside = changed.filter((n) => !spans.some(([, [a, b]]) => n >= a && n <= b));
			if (outside.length) problems.push(`the patch changes ${f} line ${outside[0]}, outside ${symbols.join(", ")}`);
		}
	}
	for (const h of invariantHits({ arch: archPaths, files })) {
		problems.push(`it reaches an invariant (${INVARIANTS.find((i) => i.id === h.invariant).words}): ${h.what}`);
	}
	problems.push(...ceilingProblems(arch, proposal.after));
	return [...new Set(problems)];
}

/** The old-side line numbers a patch removes from a file, and for a pure insertion the line it follows. */
export function changedLines(patch, file) {
	const out = [];
	let current = null;
	let old = 0;
	let replacing = false;
	for (const line of String(patch ?? "").split("\n")) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			current = header[1];
			continue;
		}
		if (current !== file) continue;
		const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
		if (hunk) {
			old = Number(hunk[1]);
			if (hunk[2] === "0") old += 1;
			replacing = false;
			continue;
		}
		if (line.startsWith("---") || line.startsWith("+++")) continue;
		if (line.startsWith("-")) {
			out.push(old++);
			replacing = true;
		} else if (line.startsWith("+")) {
			// Added lines right after removed ones replace them; others are inserted between two old lines.
			if (!replacing) out.push(Math.max(1, old - 1), old);
		} else if (line.startsWith(" ")) {
			old++;
			replacing = false;
		}
	}
	return [...new Set(out)];
}

/** Values a release ceiling caps (D-80): a proposal may move them up to the ceiling, never past it. */
export function ceilingProblems(arch, after) {
	if (!arch || !after) return [];
	const ceilings = arch.budgets?.releaseCeilings ?? {};
	const problems = [];
	const depth = getPath(after, "subAgents.maxDepth");
	if (Number.isFinite(ceilings.maxSubagentDepth) && Number.isFinite(depth) && depth > ceilings.maxSubagentDepth) {
		problems.push(`sub-agent depth ${depth} is past the release's ceiling of ${ceilings.maxSubagentDepth}`);
	}
	return problems;
}

/**
 * Where a top-level declaration of `symbol` sits in a source file: [first line, last line], 1-based, or null. It runs
 * from the line that declares it to the line before the next top-level declaration.
 */
export function symbolSpan(source, symbol) {
	const lines = source.split("\n");
	const decl = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class)\\s+${symbol.replace(/[$]/g, "\\$")}\\b`);
	const start = lines.findIndex((l) => decl.test(l));
	if (start === -1) return null;
	const next = /^(?:export\s|const\s|let\s|var\s|function[\s*]|async\s+function\s|class\s|interface\s|type\s|enum\s|\/\*\*|import\s)/;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (next.test(lines[i])) {
			end = i;
			break;
		}
	}
	while (end - 1 > start && lines[end - 1].trim() === "") end--;
	return [start + 1, end];
}
