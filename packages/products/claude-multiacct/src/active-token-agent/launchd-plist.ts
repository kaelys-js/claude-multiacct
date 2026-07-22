/**
 * `@foundation/claude-multiacct` — pure XML emitter for the active-token
 * companion's launchd agent plist.
 *
 * # Why this agent exists
 *
 * The bridge daemon runs with `SessionCreate=true` (see
 * `launch/launchd-plist.ts`), which puts it in its OWN Security session so a
 * keychain ACL prompt can never hang the long-lived process. The cost of that
 * isolation: the daemon cannot read the login keychain, so it cannot read the
 * `Claude Safe Storage` key that decrypts Claude.app's active-token marker, NOR
 * the `com.claude-multiacct.tokens` pool-token items. Both are login-keychain
 * generic passwords, both are unreachable from the daemon's session. Without
 * them the daemon can't tell which pooled account Claude.app is logged in as, so
 * the picker's active-row highlight falls back to the first account in prod.
 *
 * This companion closes that gap. It is a SHORT-LIVED, gui-session agent whose
 * distinguishing property is what it does NOT set:
 *
 *   - **No `SessionCreate`.** This is the whole point — the agent runs inside
 *     the user's aqua Security session, so its `security` reads hit the same
 *     login keychain Claude.app and the CLI wrote to. It resolves the active
 *     account and drops the answer in a file the daemon reads. Adding
 *     `SessionCreate` here would reintroduce the exact blindness that motivated
 *     the agent.
 *   - `RunAtLoad=true` — resolve once at login so the file exists before the
 *     first `/accounts` request, without waiting for a config change.
 *   - `WatchPaths=[Claude config.json]` — Claude.app rewrites `config.json`
 *     whenever the active account changes (login, logout, switch), so watching
 *     it re-fires the resolver exactly when the answer could have moved.
 *   - `KeepAlive=false` — fire-and-forget, like the watcher. It resolves, writes,
 *     exits; it is not a daemon.
 *
 * No `EnvironmentVariables` block: the runtime reads the keychain and writes a
 * file, it does not consult `CLAUDE_MULTIACCT_ENABLE_SHIM`, so baking the flag
 * in here would be cargo-culted noise. The INSTALL of this agent is still gated
 * on the flag by `agent-installer.ts`, same as the watcher and daemon.
 *
 * Values are XML-escaped defensively — user home paths can contain `&`, `<`, or
 * quotes on unusual setups.
 *
 * @module
 */

/** Canonical launchd label. Also the plist basename. */
export const ACTIVE_TOKEN_LABEL = "com.claude-multiacct.active-token";

/** Input to `renderActiveTokenPlist`. All fields required. */
export type ActiveTokenPlistInput = {
	label: string;
	watchedPath: string;
	programArgs: readonly string[];
	stdoutPath: string;
	stderrPath: string;
};

/**
 * Minimal XML escape for values embedded in plist `<string>` elements.
 *
 * @param {string} s - Raw value.
 * @returns {string} `s` with XML metacharacters replaced by entity references.
 */
function xmlEscape(s: string): string {
	const table: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&apos;",
	};
	// The regex only matches keys of `table`, so the lookup is total; the
	// non-null assertion pins that so we don't emit a `??` branch coverage
	// tests can't reach.
	return s.replaceAll(/[&<>"']/gu, (c) => table[c] as string);
}

/**
 * Render the active-token companion's launchd agent plist as XML. Pure — no I/O.
 *
 * Deliberately OMITS `SessionCreate` (see module docstring): the agent must run
 * in the user's gui Security session so its keychain reads succeed.
 *
 * @param {ActiveTokenPlistInput} input - All required fields.
 * @returns {string} Complete plist XML with trailing newline.
 */
export function renderActiveTokenPlist(input: ActiveTokenPlistInput): string {
	const args = input.programArgs.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(input.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>WatchPaths</key>
\t<array>
\t\t<string>${xmlEscape(input.watchedPath)}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(input.stdoutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`;
}
