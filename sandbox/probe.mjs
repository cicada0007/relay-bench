#!/usr/bin/env node
// Starts one sandbox from the round's image, prints what is installed and whether each tool's kernel is ready, and
// kills it. Costs about a minute of sandbox time.   node sandbox/probe.mjs
import { Sandbox } from "e2b";
import { RUN_PATH, TEMPLATE_NAME } from "./template.mjs";

const sandbox = await Sandbox.create(TEMPLATE_NAME, { timeoutMs: 5 * 60_000, envs: { DO_NOT_TRACK: "1" } });
try {
	const run = async (cmd) => {
		const result = await sandbox.commands.run(`export PATH=${RUN_PATH}; ${cmd}`, { timeoutMs: 120_000 }).catch((e) => e);
		return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	};
	console.log("versions:", (await run("relay --version 2>&1 | tail -1; prime-agent --version 2>&1 | tail -1; claude --version")).replace(/\n/g, " | "));
	console.log("whoami:", await run("whoami; echo $HOME"));
	console.log("relay kernel files:", await run("ls -d ~/.relay/agent/kernel* ~/.relay/kernel* ~/.relay/agent/*venv* 2>/dev/null | head -5; find ~/.relay -maxdepth 4 -name 'pyvenv.cfg' 2>/dev/null | head -3"));
	console.log("prime kernel files:", await run("find ~/.local/share/prime-agent ~/.prime-agent ~/.prime -maxdepth 4 -name 'pyvenv.cfg' 2>/dev/null | head -3"));
	console.log("meter:", await run("ls -l /opt/relay-bench/meter.mjs"));
	console.log("disk/cpu:", (await run("nproc; free -m | awk '/Mem/{print $2\" MB\"}'; df -h / | tail -1 | awk '{print $4\" free\"}'")).replace(/\n/g, " | "));
} finally {
	await sandbox.kill();
}
