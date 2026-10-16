// The round's meter inside one sandbox, as runner/run-one.mjs starts it, for runners that are not run-one (test G):
// the meter is uploaded from this checkout, a certificate authority made for this one run is trusted inside the sandbox
// only (sandbox/meter-intercept.sh), api.anthropic.com resolves to the meter, and the meter stops the run's model
// requests at its spend cap. run-one.mjs keeps its own copy of these steps; it is not changed while round 1 runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_PATH } from "../sandbox/template.mjs";
import { BASE_ENV, sh, sha } from "./judge.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** Where each runtime looks for trusted certificates, with the run's authority added (the same as run-one.mjs). */
export const TRUST_ENV = {
	NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/relay-bench-meter.crt",
	SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
	REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
};
export const METER_DIR = "/var/lib/relay-bench";
export const METER_LOG = `${METER_DIR}/meter.jsonl`;

/** Starts the meter at api.anthropic.com (and its plain door on 127.0.0.1:8787) with the run's cap; returns its hash. */
export async function startMeter(sandbox, capUsd) {
	const meterSource = readFileSync(join(ROOT, "meter", "meter.mjs"), "utf8");
	await sandbox.files.write("/opt/relay-bench/meter.mjs", meterSource, { user: "root" });
	await sandbox.files.write("/opt/relay-bench/meter-intercept.sh", readFileSync(join(ROOT, "sandbox", "meter-intercept.sh"), "utf8"), { user: "root" });
	const intercept = await sh(sandbox, "sh /opt/relay-bench/meter-intercept.sh", { user: "root" });
	if (intercept.exitCode !== 0) throw new Error(`the meter's certificate setup failed: ${intercept.stderr.slice(-400)}`);
	await sandbox.commands.run(
		`export PATH=${RUN_PATH}; node /opt/relay-bench/meter.mjs --port 443 --tls-cert /root/meter-tls/meter.crt ` +
			`--tls-key /root/meter-tls/meter.key --upstream https://api.anthropic.com --resolve-upstream-by-dns ` +
			`--plain-port 8787 --log ${METER_LOG} --cap-usd ${capUsd} > ${METER_DIR}/meter.out 2>&1`,
		{ background: true, envs: BASE_ENV, user: "root" },
	);
	// Checked the way the tools see it: as the sandbox user, by name, through the hosts file and the run's certificate.
	const up = await sh(
		sandbox,
		`for i in $(seq 1 50); do curl -s -o /dev/null https://api.anthropic.com/ && exit 0; sleep 0.1; done; cat ${METER_DIR}/meter.out; exit 1`,
	);
	if (up.exitCode !== 0) throw new Error(`the meter did not start: ${up.stdout.slice(-400)}`);
	return sha(meterSource);
}

/** The meter's log as entries, and the run's totals from it. */
export async function readMeter(sandbox) {
	const text = await sandbox.files.read(METER_LOG).catch(() => "");
	const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const priced = lines.filter((l) => l.costUsd !== undefined);
	const sum = (k) => priced.reduce((s, l) => s + (l[k] ?? 0), 0);
	const model = lines.filter((l) => l.path?.split("?")[0].endsWith("/messages"));
	return {
		text,
		usage: {
			requests: priced.length,
			refusedAtCap: lines.filter((l) => l.refused === "spend_cap_reached").length,
			providerErrors: model.filter((l) => l.status === 0 || l.status >= 500).length,
			input: sum("input"),
			output: sum("output"),
			cacheRead: sum("cacheRead"),
			cacheWrite: sum("cacheWrite"),
			costUsd: sum("costUsd"),
			modelsSeen: [...new Set(lines.map((l) => l.model).filter(Boolean))],
			effortsAsked: [...new Set(lines.map((l) => l.effort ?? l.thinking).filter(Boolean))],
			unpricedModels: [...new Set(lines.filter((l) => l.model && l.costUsd === undefined).map((l) => l.model))],
		},
		lastModelStatus: model.length ? model[model.length - 1].status : undefined,
	};
}
