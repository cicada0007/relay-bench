// Pre-screen: each proposal's Relay build against the champion, paired, before a combined release goes to the gate.
//
// Two sets, in order:
// - the dev set: practice tasks, where everything may be seen. The champion and the build (relay@pkg, GATE.md: an
//   unreleased build is pre-screened only, in a dev test) run every task the same number of times, and the dev set is
//   read with the gate's own code. A proposal is dropped when that read blocks it, when its whole interval is below
//   zero, or when it costs or takes more than the gate allows.
// - the selection set: the check tier. The loop sees only the check tier's one word, pass or fail, through its door
//   (scripts/check-query.mjs). Every run of a check task and every answer is counted against the leak budget
//   (runner/exposure.mjs), and the loop also counts its own selection queries per cycle. A pre-screen that would pass
//   either runs nothing.
// Money: every stage runs within what its lane has left this cycle and what the command's --spend-cap has left, and
// run-stage itself never spends past the cap it is given. Without a cap nothing here runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRecords } from "../runner/analyze.mjs";
import { budgetProblems, exposurePathFor, loadBudget, readExposures } from "../runner/exposure.mjs";
import { gate, RULES as GATE_RULES } from "../runner/gate-analyze.mjs";
import { readTasks } from "../runner/stage-tasks.mjs";
import { needsMetaHarness } from "./lanes.mjs";

/** E2B, 2 vCPU + 4 GiB, as runner/run-stage.mjs prices it. */
export const E2B_USD_PER_SECOND = 0.000046;

/**
 * The money one cycle may spend: each lane's fixed budget for the cycle (spent across every command of the cycle, in
 * `entries`), and the command's own --spend-cap. `fits` says why an amount would pass either, or null.
 */
export function wallet({ settings, cap, entries = [] }) {
	const spentThisCommand = [];
	const laneSpent = (lane) => entries.filter((e) => e.lane === lane).reduce((s, e) => s + e.usd, 0) + spentThisCommand.filter((e) => e.lane === lane).reduce((s, e) => s + e.usd, 0);
	const commandSpent = () => spentThisCommand.reduce((s, e) => s + e.usd, 0);
	const laneBudget = (lane) => settings.lanes?.[lane]?.budgetUsd ?? 0;
	return {
		cap,
		laneSpent,
		laneBudget,
		commandSpent,
		laneLeft: (lane) => Math.max(0, laneBudget(lane) - laneSpent(lane)),
		capLeft: () => (cap === null ? 0 : Math.max(0, cap - commandSpent())),
		fits(lane, usd) {
			if (cap === null) return "no --spend-cap was given";
			if (laneSpent(lane) + usd > laneBudget(lane) + 1e-9) return `the ${lane} lane has $${Math.max(0, laneBudget(lane) - laneSpent(lane)).toFixed(2)} of its $${laneBudget(lane).toFixed(2)} left this cycle`;
			if (commandSpent() + usd > cap + 1e-9) return `the --spend-cap of $${cap.toFixed(2)} has $${Math.max(0, cap - commandSpent()).toFixed(2)} left`;
			return null;
		},
		add(entry) {
			spentThisCommand.push(entry);
			return entry;
		},
		added: () => [...spentThisCommand],
	};
}

/** The most one pre-screen of a proposal can cost, in model dollars, and its runs: both arms, every task, every rep. */
export function prescreenPlan({ devTasks, checkTasks, settings }) {
	const p = settings.prescreen;
	const devRuns = devTasks.length * 2 * p.devReps;
	const selectionRuns = checkTasks.length * 2 * p.selectionReps;
	return { devRuns, selectionRuns, worstUsd: (devRuns + selectionRuns) * p.capUsdPerRun };
}

/** The check tasks' exposures a selection would add: every run, and one read for the answer (runner/exposure.mjs). */
export function selectionExposures({ checkTasks, reps, test, candidate }) {
	const runs = checkTasks.flatMap((t) => Array.from({ length: 2 * reps }, () => ({ kind: "run", tier: "check", tasks: [t], test, by: "loop" })));
	return [...runs, { kind: "read", tier: "check", tasks: [...checkTasks], test, by: "loop", key: `loop:${test}:${candidate}` }];
}

/** The model dollars a run-stage printed it had spent, or null. */
export function stageSpent(stdout) {
	const finished = /finished: \$(\d+(?:\.\d+)?) spent/.exec(stdout ?? "");
	if (finished) return Number(finished[1]);
	const all = [...String(stdout ?? "").matchAll(/\| stage \$(\d+(?:\.\d+)?)/g)];
	return all.length ? Number(all.at(-1)[1]) : null;
}

/** The dev set's read: the gate's own measures on practice, and whether the proposal goes on. */
export function readDev(records, { champion, candidate }) {
	const g = gate(records, { champion, candidate });
	const reasons = [];
	if (g.status === "BLOCK") reasons.push(`the gate's read of the dev set blocks it (${g.label})`);
	if (g.high !== null && g.high < 0) reasons.push("its whole interval on the dev set is below zero");
	if (g.costRatio !== null && g.costRatio > GATE_RULES.costRatio) reasons.push(`it costs ${((g.costRatio - 1) * 100).toFixed(1)}% more than the champion on the dev set`);
	if (g.timeRatio !== null && g.timeRatio > GATE_RULES.timeRatio) reasons.push(`it takes ${((g.timeRatio - 1) * 100).toFixed(1)}% longer than the champion on the dev set`);
	return {
		tasks: g.tasks,
		difference: g.difference,
		low: g.low,
		high: g.high,
		costRatio: g.costRatio,
		timeRatio: g.timeRatio,
		safetyFlags: g.safety.candidate.total,
		gateStatus: g.status,
		gateLabel: g.label,
		kept: reasons.length === 0,
		reasons,
	};
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Pre-screens each proposal that has a build. `exec(script, args)` runs one of this repository's scripts and returns
 * { status, stdout, stderr } (tests pass a fake run-stage). `done` maps proposal ids to results already in the cycle,
 * which are kept, so a cycle run again resumes. Returns { results, spend, queries }.
 */
export async function prescreen({ proposals, cycleDir, settings, money, champion, model, practiceTasksDir, devTasks, exam = null, packages, exec, done = {}, queriesSoFar = 0, log = () => {} }) {
	const p = settings.prescreen;
	const results = [];
	const spend = [];
	let queries = queriesSoFar;
	const examTasks = exam ? join(exam, "tasks") : null;
	const checkTasks = examTasks && existsSync(examTasks) ? [...readTasks(examTasks)].filter(([, t]) => t.tier === "check").map(([id]) => id) : [];
	const champ = `relay@${champion}`;
	const devOut = join(cycleDir, "runs", "dev");

	for (const proposal of proposals) {
		// Passed, dropped and held are final for the cycle; a proposal that waited for a build or money is tried again.
		if (["passed", "dropped", "held"].includes(done[proposal.id]?.status)) {
			results.push(done[proposal.id]);
			continue;
		}
		const lane = proposal.lane;
		const result = { id: proposal.id, lane, status: "waiting", dev: null, selection: null, spentUsd: 0, why: [] };
		const pkg = packages ? join(packages, `${proposal.id}.tgz`) : null;
		if (!pkg || !existsSync(pkg)) {
			result.why.push(`waiting for a build: ${pkg ?? "<packages>/" + proposal.id + ".tgz"} (RUNBOOK.md, "The improvement loop")`);
			results.push(result);
			continue;
		}
		const one = p.capUsdPerRun;
		const refusal = money.fits(lane, one);
		if (refusal) {
			result.status = "refused";
			result.why.push(`not run: ${refusal}, less than one run's cap of $${one.toFixed(2)}`);
			results.push(result);
			continue;
		}

		// The dev set.
		const devTest = `dev-loop-${proposal.id}`;
		// A change that acts only with the meta-harness on (the router's) is measured with it on, for both arms.
		const meta = needsMetaHarness(proposal) ? ["--relay-meta"] : [];
		const devCap = Math.min(money.laneLeft(lane), money.capLeft(), devTasks.length * 2 * p.devReps * one);
		log(`pre-screen ${proposal.id}: dev set, ${devTasks.length} tasks, at most $${devCap.toFixed(2)}`);
		const devRun = exec("runner/run-stage.mjs", [
			"--test", devTest, "--model", model, "--tools", `${champ},relay@pkg`, "--relay-package", pkg,
			"--tasks", devTasks.join(","), "--tasks-dir", practiceTasksDir, "--reps", String(p.devReps),
			"--cap-usd", String(one), "--stage-cap-usd", devCap.toFixed(4), "--e2b-cap-usd", String(p.e2bCapUsd),
			"--concurrency", String(p.concurrency), "--out", devOut, ...meta,
		]);
		const devRecords = existsSync(join(devOut, "records.jsonl")) ? loadRecords(devOut, devTest) : [];
		const devSpent = sum(devRecords.map((r) => r.usage?.costUsd ?? 0));
		spend.push(money.add({ lane, step: "dev", proposal: proposal.id, usd: devSpent }));
		result.spentUsd += devSpent;
		if (devRun.status !== 0) result.why.push(`the dev stage exited ${devRun.status}; reading what finished`);
		result.dev = readDev(devRecords, { champion: champ, candidate: "relay@pkg" });
		result.dev.sandboxUsd = sum(devRecords.map((r) => ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000 || 0) * E2B_USD_PER_SECOND));
		if (!result.dev.tasks) {
			result.status = "waiting";
			result.why.push("no dev task has a grade for both arms yet");
			results.push(result);
			continue;
		}
		if (!result.dev.kept) {
			result.status = "dropped";
			result.why.push(...result.dev.reasons);
			results.push(result);
			continue;
		}

		// The selection set: the check tier's one word.
		if (!exam) result.selection = { status: "not available", why: "no exam folder was given (--exam)" };
		else if (!checkTasks.length) result.selection = { status: "not available", why: "the check tier has no tasks yet (TIERS.md)" };
		else {
			const selTest = `dev-loop-sel-${proposal.id}`;
			const selOut = join(exam, "runs", "loop", proposal.id.split("-").slice(0, 2).join("-"));
			const planned = selectionExposures({ checkTasks, reps: p.selectionReps, test: selTest, candidate: "relay@pkg" });
			const leak = budgetProblems({ entries: readExposures(exposurePathFor(examTasks)), add: planned, budget: loadBudget(examTasks) });
			const selWorst = checkTasks.length * 2 * p.selectionReps * one;
			const selMoney = money.fits(lane, one);
			if (leak.length) result.selection = { status: "refused", why: `the leak budget would be passed: ${leak.slice(0, 2).join("; ")}` };
			else if (queries >= p.maxSelectionQueries) result.selection = { status: "refused", why: `this cycle has asked the check tier ${queries} times, its limit` };
			else if (selMoney) result.selection = { status: "refused", why: `not run: ${selMoney}` };
			else {
				const selCap = Math.min(money.laneLeft(lane), money.capLeft(), selWorst);
				log(`pre-screen ${proposal.id}: selection set, ${checkTasks.length} check tasks, at most $${selCap.toFixed(2)}`);
				const selRun = exec("runner/run-stage.mjs", [
					"--test", selTest, "--model", model, "--tools", `${champ},relay@pkg`, "--relay-package", pkg,
					"--tasks", "tier:check", "--tasks-dir", examTasks, "--reps", String(p.selectionReps),
					"--cap-usd", String(one), "--stage-cap-usd", selCap.toFixed(4), "--e2b-cap-usd", String(p.e2bCapUsd),
					"--concurrency", String(p.concurrency), "--out", selOut, ...meta,
				]);
				// The check tier's runs are never read here: their spend is what run-stage printed, or all it was allowed.
				const selSpent = stageSpent(selRun.stdout) ?? selCap;
				spend.push(money.add({ lane, step: "selection", proposal: proposal.id, usd: selSpent }));
				result.spentUsd += selSpent;
				const door = exec("scripts/check-query.mjs", ["--out", selOut, "--test", selTest, "--champion", champion, "--candidate", "pkg", "--tasks-dir", examTasks]);
				queries++;
				const answer = door.status === 0 ? "pass" : door.status === 1 ? "fail" : null;
				result.selection = answer ? { status: answer, query: queries } : { status: "refused", why: `the check tier's door answered nothing: ${(door.stderr ?? "").trim().split("\n")[0]}` };
			}
		}
		if (result.selection.status === "fail") {
			result.status = "dropped";
			result.why.push("the check tier answered fail");
		} else if (result.selection.status === "refused") {
			result.status = "held";
			result.why.push(`the selection set was not asked: ${result.selection.why}`);
		} else result.status = "passed";
		results.push(result);
	}
	return { results, spend, queries };
}
