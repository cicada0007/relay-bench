"""Test F's two agents for Harbor: Relay, and Harbor's own Claude Code agent, both on one model and one cost meter.

Harbor (github.com/harbor-framework/harbor) runs Terminal-Bench 2.1. It imports these by path:

    PYTHONPATH=harbor-agents harbor run -a relay_bench_agents:Relay ...
    PYTHONPATH=harbor-agents harbor run -a relay_bench_agents:BenchClaudeCode ...

What both agents share, so the two tools differ only in the tool:

- The same Node.js (pinned, checksum verified) in /opt/relay-bench/node. Relay needs Node 22; Harbor's Claude Code agent
  would otherwise install the distribution's Node. When the task image has no `node`, it is linked into /usr/local/bin
  for both tools alike, so both see the same toolchain.
- The round's cost meter (meter/meter.mjs, uploaded from this checkout on every trial). As in the rest of the round
  (PREREGISTRATION.md, amendment 1), no tool's endpoint setting changes: inside the task container api.anthropic.com
  resolves to 127.0.0.1, where the meter answers with a certificate from an authority made for this one trial. Its
  private key exists only in this process's memory and is never written anywhere. Only the tool's own process trusts
  that authority (NODE_EXTRA_CA_CERTS, and a CA bundle of the system's authorities plus it); the system store is not
  touched. The meter forwards every request unchanged, logs token counts (never prompts or keys) to
  /logs/agent/meter.jsonl, and refuses requests once the trial reaches its spend cap (`cap_usd`).
- Harbor's usage fields (cost_usd, n_input_tokens, n_cache_tokens, n_output_tokens, model_usage) come from the meter for
  both tools. What each tool reported about itself is kept beside it in metadata.

Relay runs in its own non-interactive mode, `relay -p`, with its JSON event stream, every model tier set to the test
model (as runner/arms.mjs sets it). It has no permission prompts to skip. Claude Code is Harbor's built-in agent
unchanged (`--permission-mode=bypassPermissions`, IS_SANDBOX=1), pinned to 2.1.300 with every tier on the test model,
as runner/arms.mjs pins it.
"""

from __future__ import annotations

import datetime
import json
import shlex
import tempfile
import uuid
from pathlib import Path
from typing import Any, override

from pydantic import Field

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.claude_code import ClaudeCode, ClaudeCodeOptions
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage

ROOT = Path(__file__).resolve().parent.parent

# The round's frozen pins (sandbox/template.mjs) and the Node.js build both tools get, from nodejs.org/dist/v22.23.1.
RELAY_VERSION = "0.6.118"
CLAUDE_CODE_VERSION = "2.1.300"
NODE_VERSION = "22.23.1"
NODE_SHA256 = {
    "x64": "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578",
    "arm64": "0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1",
}
DEFAULT_CAP_USD = "1"

BENCH = "/opt/relay-bench"
NODE_BIN = f"{BENCH}/node/bin"
TLS = f"{BENCH}/tls"
CA_CERT = f"{TLS}/ca.crt"
CA_BUNDLE = f"{TLS}/bundle.pem"
HOSTS_MARK = "# relay-bench meter"
METER_LOG = "meter.jsonl"


def _meter_certificates() -> tuple[bytes, bytes, bytes]:
    """A certificate authority for one trial and a certificate for api.anthropic.com signed by it.

    Returns (ca_cert_pem, server_cert_pem, server_key_pem). The authority's private key is never serialized, so once this
    function returns nothing can sign with it again."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "relay-bench meter, one trial")])
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False, key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "api.anthropic.com")]))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("api.anthropic.com")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    del ca_key
    return (
        ca.public_bytes(serialization.Encoding.PEM),
        cert.public_bytes(serialization.Encoding.PEM),
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ),
    )


def meter_totals(logs_dir: Path) -> dict[str, Any] | None:
    """Totals from the trial's meter log, or None when there is no log."""
    path = logs_dir / METER_LOG
    if not path.is_file():
        return None
    totals: dict[str, Any] = {
        "requests": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.0,
        "refusedAtCap": 0, "errors": 0, "models": {}, "askedModels": {},
    }
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("refused"):
            totals["refusedAtCap"] += 1
            continue
        if "input" not in entry:
            continue
        if entry.get("status") != 200:
            totals["errors"] += 1
        totals["requests"] += 1
        for k in ("input", "output", "cacheRead", "cacheWrite"):
            totals[k] += int(entry.get(k) or 0)
        totals["costUsd"] += float(entry.get("costUsd") or 0)
        for field, bucket in (("model", "models"), ("askedModel", "askedModels")):
            if entry.get(field):
                totals[bucket][entry[field]] = totals[bucket].get(entry[field], 0) + 1
        model = entry.get("model") or entry.get("askedModel") or "unknown"
        usage = totals.setdefault("byModel", {}).setdefault(
            model, {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.0}
        )
        for k in ("input", "output", "cacheRead", "cacheWrite"):
            usage[k] += int(entry.get(k) or 0)
        usage["costUsd"] += float(entry.get("costUsd") or 0)
    return totals


def fill_context_from_meter(context: AgentContext, logs_dir: Path, tool_reported: dict[str, Any] | None) -> None:
    """Harbor's usage fields, from the meter, with the tool's own report kept beside them."""
    meter = meter_totals(logs_dir)
    metadata = dict(context.metadata or {})
    if tool_reported is not None:
        metadata["toolReported"] = tool_reported
    if meter is None:
        metadata["meter"] = None
        context.metadata = metadata
        return
    metadata["meter"] = meter
    context.metadata = metadata
    context.cost_usd = round(meter["costUsd"], 6)
    context.n_input_tokens = meter["input"] + meter["cacheRead"] + meter["cacheWrite"]
    context.n_cache_tokens = meter["cacheRead"]
    context.n_output_tokens = meter["output"]
    context.model_usage = {
        model: ModelUsage(
            n_input_tokens=u["input"] + u["cacheRead"] + u["cacheWrite"],
            n_cache_tokens=u["cacheRead"],
            n_output_tokens=u["output"],
            cost_usd=round(u["costUsd"], 6),
        )
        for model, u in meter.get("byModel", {}).items()
    }


class BenchSetup:
    """The toolchain and meter both agents share. Mixed into a BaseInstalledAgent."""

    async def bench_install(self: Any, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "git", "xz", "procps", "ca_certificates", "coreutils", "tar")
        )
        sums = " ".join(f"{arch}={sha}" for arch, sha in NODE_SHA256.items())
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                f"if [ ! -x {NODE_BIN}/node ]; then "
                '  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; '
                '    *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;; esac; '
                f"  for pair in {sums}; do [ \"${{pair%%=*}}\" = \"$arch\" ] && sum=\"${{pair#*=}}\"; done; "
                f"  file=node-v{NODE_VERSION}-linux-$arch.tar.xz; tmp=$(mktemp -d); "
                f"  curl -fsSL https://nodejs.org/dist/v{NODE_VERSION}/$file -o $tmp/$file; "
                '  echo "$sum  $tmp/$file" | sha256sum -c - >/dev/null; '
                f"  mkdir -p {BENCH}/node; tar -xJf $tmp/$file -C {BENCH}/node --strip-components=1; rm -rf $tmp; "
                "fi; "
                # Same Node for both tools: linked onto PATH only when the task image has none of its own.
                "if ! command -v node >/dev/null 2>&1; then "
                f"  for b in node npm npx; do ln -sf {NODE_BIN}/$b /usr/local/bin/$b; done; "
                "fi; "
                f"{NODE_BIN}/node --version"
            ),
        )
        await environment.upload_file(ROOT / "meter" / "meter.mjs", f"{BENCH}/meter.mjs")

    async def meter_start(self: Any, environment: BaseEnvironment, cap_usd: str) -> dict[str, str]:
        """Starts the meter at api.anthropic.com; returns the trust settings for the tool's process only."""
        ca, cert, key = _meter_certificates()
        with tempfile.TemporaryDirectory(prefix="relay-bench-meter-") as tmp:
            for name, data in (("ca.crt", ca), ("meter.crt", cert), ("meter.key", key)):
                (Path(tmp) / name).write_bytes(data)
            await self.exec_as_root(environment, command=f"mkdir -p {TLS} && chmod 755 {TLS}")
            for name in ("ca.crt", "meter.crt", "meter.key"):
                await environment.upload_file(Path(tmp) / name, f"{TLS}/{name}")
        log = (self.environment_logs_dir / METER_LOG).as_posix()
        out = (self.environment_logs_dir / "meter.out").as_posix()
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                f"chmod 600 {TLS}/meter.key; chmod 644 {TLS}/ca.crt {TLS}/meter.crt; "
                f"system=; for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do "
                '  [ -f "$f" ] && { system="$f"; break; }; done; '
                f'{{ [ -n "$system" ] && cat "$system"; cat {CA_CERT}; }} > {CA_BUNDLE}; chmod 644 {CA_BUNDLE}; '
                f"mkdir -p {shlex.quote(self.environment_logs_dir.as_posix())}; : > {log}; "
                f"grep -q '{HOSTS_MARK}' /etc/hosts || echo '127.0.0.1 api.anthropic.com {HOSTS_MARK}' >> /etc/hosts; "
                f"setsid nohup {NODE_BIN}/node {BENCH}/meter.mjs --port 443 --tls-cert {TLS}/meter.crt "
                f"--tls-key {TLS}/meter.key --upstream https://api.anthropic.com --resolve-upstream-by-dns "
                f"--log {log} --cap-usd {shlex.quote(str(cap_usd))} > {out} 2>&1 < /dev/null & "
                "for i in $(seq 1 100); do "
                f"  curl -s -o /dev/null --cacert {CA_CERT} https://api.anthropic.com/ && exit 0; sleep 0.1; "
                f"done; cat {out} >&2; exit 1"
            ),
        )
        return {
            "NODE_EXTRA_CA_CERTS": CA_CERT,
            "SSL_CERT_FILE": CA_BUNDLE,
            "REQUESTS_CA_BUNDLE": CA_BUNDLE,
            "CURL_CA_BUNDLE": CA_BUNDLE,
        }

    async def meter_stop(self: Any, environment: BaseEnvironment) -> None:
        """Stops the meter and gives api.anthropic.com back to DNS before the verifier runs."""
        try:
            await environment.exec(
                command=(
                    "pkill -f 'relay-bench/meter.mjs' >/dev/null 2>&1 || true; "
                    f"grep -v '{HOSTS_MARK}' /etc/hosts > /tmp/.relay-bench-hosts && cat /tmp/.relay-bench-hosts > /etc/hosts; "
                    f"rm -f /tmp/.relay-bench-hosts {TLS}/meter.key"
                ),
                user="root",
            )
        except Exception as exc:  # the trial's result matters more than the cleanup
            self.logger.warning(f"meter cleanup failed: {exc}")


class RelayOptions(InstalledAgentOptions):
    cap_usd: str = Field(default=DEFAULT_CAP_USD, description="The trial's spend cap, enforced by the meter.")


class Relay(BaseInstalledAgent, BenchSetup):
    """Relay (relayevals.com) in its own non-interactive mode, `relay -p`, on one model for every tier."""

    capabilities = AgentCapabilities()
    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="anthropic", api_key_envs=("ANTHROPIC_API_KEY",), base_url_envs=()
    )
    options_model = RelayOptions
    options: RelayOptions

    def __init__(self, logs_dir: Path, *args, **kwargs):
        kwargs.setdefault("version", RELAY_VERSION)
        super().__init__(logs_dir, *args, **kwargs)

    @staticmethod
    @override
    def name() -> str:
        return "relay"

    @override
    def get_version_command(self) -> str | None:
        return f'export PATH="{NODE_BIN}:$PATH"; relay --version 2>&1'

    @override
    def parse_version(self, stdout: str) -> str:
        lines = [line.strip() for line in stdout.strip().splitlines() if line.strip()]
        return lines[-1] if lines else stdout.strip()

    def _model(self) -> str:
        if not self.model_name:
            raise ValueError("Relay needs a model, e.g. -m anthropic/claude-haiku-5-5")
        return self.model_name.split("/", 1)[-1]

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.bench_install(environment)
        version = self._version or RELAY_VERSION
        await self.exec_as_agent(
            environment,
            command=(
                "set -eu; "
                f'export PATH="{NODE_BIN}:$PATH"; '
                f"curl -fsSL https://relayevals.com/harness/install.sh | RELAY_VERSION={shlex.quote(version)} "
                "RELAY_BOOTSTRAP_KERNEL_ON_INSTALL=1 DO_NOT_TRACK=1 sh; "
                f'installed=$(relay --version 2>&1 | tail -1); [ "$installed" = {shlex.quote(version)} ] || '
                f'{{ echo "relay $installed installed, wanted {version}" >&2; exit 1; }}'
            ),
        )
        # One model on every tier, as runner/arms.mjs sets Relay up; anything the installer wrote is kept.
        model = self._model()
        settings = {
            "defaultProvider": "anthropic",
            "defaultModel": model,
            "models": {"tiers": {t: f"anthropic/{model}" for t in ("decider", "strong", "fast")}},
        }
        merge = (
            "const fs=require('fs'),p=require('os').homedir()+'/.relay/agent/settings.json';"
            "fs.mkdirSync(require('path').dirname(p),{recursive:true});"
            "let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{};"
            "const w=JSON.parse(process.env.RELAY_BENCH_SETTINGS);"
            "s={...s,...w,models:{...(s.models||{}),...w.models}};"
            "fs.writeFileSync(p,JSON.stringify(s,null,2));console.log(p)"
        )
        await self.exec_as_agent(
            environment,
            command=f"{NODE_BIN}/node -e {shlex.quote(merge)}",
            env={"RELAY_BENCH_SETTINGS": json.dumps(settings)},
        )

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        api_key = self.model_connection.api_key or self._get_env("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY is not set for the Relay agent")
        trust = await self.meter_start(environment, self.options.cap_usd)
        logs = self.environment_logs_dir.as_posix()
        var = f"relay_bench_instruction_{uuid.uuid4().hex}"
        env = {
            **trust,
            "ANTHROPIC_API_KEY": api_key,
            "DO_NOT_TRACK": "1",
            var.upper(): instruction,
        }
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f'export PATH="{NODE_BIN}:$PATH"; '
                    f'{var}="${var.upper()}"; unset {var.upper()}; '
                    f"relay -p --mode json --session-dir {logs}/sessions -- \"${var}\" "
                    f"< /dev/null 2> {logs}/relay.stderr.txt | tee {logs}/relay.jsonl"
                ),
                env=env,
            )
        finally:
            await self.meter_stop(environment)

    def _relay_reported(self) -> dict[str, Any] | None:
        """What Relay's own JSON stream says it used: the sum over its assistant messages."""
        path = self.logs_dir / "relay.jsonl"
        if not path.is_file():
            return None
        totals = {"messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.0}
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = event.get("message") if isinstance(event, dict) else None
            if event.get("type") != "message_end" or not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            usage = message.get("usage") or {}
            totals["messages"] += 1
            for k in ("input", "output", "cacheRead", "cacheWrite"):
                totals[k] += int(usage.get(k) or 0)
            totals["costUsd"] += float((usage.get("cost") or {}).get("total") or 0)
        return totals

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        fill_context_from_meter(context, self.logs_dir, self._relay_reported())


class BenchClaudeCodeOptions(ClaudeCodeOptions):
    cap_usd: str = Field(default=DEFAULT_CAP_USD, description="The trial's spend cap, enforced by the meter.")


class BenchClaudeCode(ClaudeCode, BenchSetup):
    """Harbor's own Claude Code agent, unchanged, plus the shared meter and every model tier on the test model."""

    options_model = BenchClaudeCodeOptions
    options: BenchClaudeCodeOptions

    def __init__(self, logs_dir: Path, *args, **kwargs):
        kwargs.setdefault("version", CLAUDE_CODE_VERSION)
        super().__init__(logs_dir, *args, **kwargs)
        model = (self.model_name or "").split("/", 1)[-1]
        if not model:
            raise ValueError("Claude Code needs a model, e.g. -m anthropic/claude-haiku-5-5")
        # runner/arms.mjs: every Claude Code tier pinned to the test model, so background requests use no second model.
        self._extra_env.update(
            {
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
                "ANTHROPIC_SMALL_FAST_MODEL": model,
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "DISABLE_AUTOUPDATER": "1",
                "DO_NOT_TRACK": "1",
            }
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.bench_install(environment)
        await super().install(environment)

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        trust = await self.meter_start(environment, self.options.cap_usd)
        try:
            # The trust settings reach the claude process (and only the agent phase) as an exec-env overlay.
            with environment.scoped_exec_env(trust):
                await super().run(instruction=instruction, environment=environment, context=context)
        finally:
            await self.meter_stop(environment)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        reported = {
            "costUsd": context.cost_usd,
            "n_input_tokens": context.n_input_tokens,
            "n_cache_tokens": context.n_cache_tokens,
            "n_output_tokens": context.n_output_tokens,
        }
        fill_context_from_meter(context, self.logs_dir, reported)
