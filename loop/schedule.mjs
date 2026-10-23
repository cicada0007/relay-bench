// The autopilot's weekly schedule (AUTOPILOT.md): a macOS launchd agent, or a crontab line for Linux, that runs
// `node loop/autopilot.mjs` once a week with the founder's cap. Nothing is scheduled until the founder runs
// `node loop/autopilot.mjs --install-schedule weekly ...` themselves.
//
// No key is ever written into the plist or the crontab line. The job starts through zsh, which reads ~/.zshenv (where
// E2B_API_KEY already lives), and the autopilot reads the model key from the Keychain at run time
// (`--keychain relay-openai`), into its own environment only.
import { dirname, join } from "node:path";

export const LABEL = "com.relayevals.relay-autopilot";
/** Monday 06:00 local time: the ISO week has just begun, so the cycle is the new week's. */
export const WHEN = Object.freeze({ weekday: 1, hour: 6, minute: 0 });

const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The arguments the weekly job passes; refuses anything that looks like a key. */
export function scheduleArgs({ spendCap, signedBy, keychain = "relay-openai", extra = [] }) {
	if (!(Number.isFinite(spendCap) && spendCap > 0)) throw new Error("a schedule needs the weekly --spend-cap <usd>, the most a week may spend");
	if (!signedBy) throw new Error("a schedule needs --signed-by <your name>: the person who stands behind each ledger entry the autopilot writes");
	const args = ["--spend-cap", String(spendCap), "--signed-by", signedBy, ...(keychain ? ["--keychain", keychain] : []), ...extra];
	for (const a of args) if (secretLike(a)) throw new Error("a schedule never carries a key; pass --keychain <service> and keep keys in the Keychain or ~/.zshenv");
	return args;
}

/** A value that looks like a key or token: never written into a schedule. */
export const secretLike = (s) => /(sk-[A-Za-z0-9_-]{8,}|e2b_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_|xox[abp]-|AKIA[0-9A-Z]{12,}|_KEY=|_TOKEN=)/.test(String(s));

/** The launchd plist: zsh -c 'exec "$0" "$@"' node autopilot.mjs <args>, every Monday at 06:00, logs in runs/. */
export function plist({ bench, node, args, logDir = join(bench, "runs", "autopilot"), when = WHEN }) {
	const program = ["/bin/zsh", "-c", 'exec "$0" "$@"', node, join(bench, "loop", "autopilot.mjs"), ...args];
	const envPath = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((p, i, a) => a.indexOf(p) === i).join(":");
	const text = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		`\t<key>Label</key>\n\t<string>${LABEL}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...program.map((a) => `\t\t<string>${xml(a)}</string>`),
		"\t</array>",
		`\t<key>WorkingDirectory</key>\n\t<string>${xml(bench)}</string>`,
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		`\t\t<key>PATH</key>\n\t\t<string>${xml(envPath)}</string>`,
		"\t</dict>",
		"\t<key>StartCalendarInterval</key>",
		"\t<dict>",
		`\t\t<key>Weekday</key>\n\t\t<integer>${when.weekday}</integer>`,
		`\t\t<key>Hour</key>\n\t\t<integer>${when.hour}</integer>`,
		`\t\t<key>Minute</key>\n\t\t<integer>${when.minute}</integer>`,
		"\t</dict>",
		"\t<key>RunAtLoad</key>\n\t<false/>",
		`\t<key>StandardOutPath</key>\n\t<string>${xml(join(logDir, "weekly.log"))}</string>`,
		`\t<key>StandardErrorPath</key>\n\t<string>${xml(join(logDir, "weekly.log"))}</string>`,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
	if (secretLike(text)) throw new Error("the plist would carry a key; nothing was written");
	return text;
}

/** The crontab line for Linux: the same job, keys from a file the founder keeps (chmod 600), never from the line. */
export function crontabLine({ bench, node, args, when = WHEN, envFile = "$HOME/.relay-autopilot.env" }) {
	const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
	const line = `${when.minute} ${when.hour} * * ${when.weekday} . ${envFile} && cd ${q(bench)} && ${q(node)} loop/autopilot.mjs ${args.filter((a, i, all) => a !== "--keychain" && all[i - 1] !== "--keychain").map(q).join(" ")} >> runs/autopilot/weekly.log 2>&1`;
	if (secretLike(line)) throw new Error("the crontab line would carry a key");
	return line;
}

export const plistPath = (home) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
