// harbor-agents/relay_bench_agents.py, loaded by the pinned Harbor's own Python with nothing run: the Codex agent next to
// Relay and Claude Code, each pinned, and the meter's certificate for the provider's name. Skipped where Harbor is not
// installed (uv tool install 'harbor[e2b]==0.24.0').
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const PYTHON = join(homedir(), ".local", "share", "uv", "tools", "harbor", "bin", "python");

const CHECK = `
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import relay_bench_agents as a
from cryptography import x509
logs = Path(tempfile.mkdtemp())
codex = a.BenchCodex(logs_dir=logs, model_name="openai/gpt-6-luna", cap_usd="0.5")
relay_openai = a.Relay(logs_dir=logs, model_name="openai/gpt-6-luna")
relay = a.Relay(logs_dir=logs, model_name="anthropic/claude-haiku-5-5")
claude = a.BenchClaudeCode(logs_dir=logs, model_name="anthropic/claude-haiku-5-5")
def names(hosts):
    cert = x509.load_pem_x509_certificate(a._meter_certificates(hosts)[1])
    return cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
print(json.dumps({
    "codex": [codex.name(), codex._version, codex.options.cap_usd, codex.model_connection.provider, codex.build_cli_flags()],
    "relay": [relay._provider(), relay.model_connection.provider, relay_openai._provider(), relay_openai.model_connection.provider],
    "claude": claude._version,
    "openaiNames": names(a.PROVIDER_HOSTS["openai"]),
    "anthropicNames": names(a.PROVIDER_HOSTS["anthropic"]),
}))
`;

test("the Harbor agents load: Codex pinned and metered at api.openai.com, Relay on either provider", { skip: !existsSync(PYTHON) && "Harbor is not installed" }, () => {
	const out = spawnSync(PYTHON, ["-I", "-c", CHECK, join(ROOT, "harbor-agents")], { encoding: "utf8", cwd: ROOT });
	assert.equal(out.status, 0, out.stderr);
	const r = JSON.parse(out.stdout.trim().split("\n").at(-1));
	assert.deepEqual(r.codex, ["codex", "0.163.0", "0.5", "openai", ""], "the cap is the meter's, never a Codex flag");
	assert.deepEqual(r.relay, ["anthropic", "anthropic", "openai", "openai"]);
	assert.equal(r.claude, "2.1.300");
	assert.deepEqual(r.openaiNames, ["api.openai.com"]);
	assert.deepEqual(r.anthropicNames, ["api.anthropic.com"]);
});
