/**
 * `@foundation/claude-multiacct` — pure XML emitter for the bridge daemon's
 * launchd agent plist.
 *
 * Distinct shape from the watcher plist:
 *
 *  - `RunAtLoad=true` — the daemon must be listening BEFORE the user
 *    launches Claude, so launchd starts it at login.
 *  - `KeepAlive=true` — if the daemon crashes, launchd relaunches it;
 *    the daemon is a long-lived service, not a fire-and-forget hook.
 *  - No `WatchPaths` — the daemon is not a WatchPaths-triggered hook.
 *  - `StandardOutPath` / `StandardErrorPath` under
 *    `~/.claude-multiacct/logs/` for post-mortem.
 *  - `EnvironmentVariables` bakes in `CLAUDE_MULTIACCT_ENABLE_SHIM=1`
 *    for the SAME reason the watcher plist does: launchd's inherited
 *    env is empty, so without the bake-in the daemon would run under
 *    launchd and refuse every mutating request (flag off), which would
 *    render the whole PR a no-op in prod.
 *
 * Values are XML-escaped defensively — user home paths can contain `&`,
 * `<`, or quotes on unusual setups.
 *
 * @module
 */

/** Canonical launchd label. Also the plist basename. */
export const DAEMON_LABEL = "com.claude-multiacct.bridge-daemon";

/** Input to `renderDaemonPlist`. All fields required. */
export type DaemonPlistInput = {
	label: string;
	programArgs: readonly string[];
	stdoutPath: string;
	stderrPath: string;
};

function xmlEscape(s: string): string {
	const table: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&apos;",
	};
	return s.replaceAll(/[&<>"']/gu, (c) => table[c] as string);
}

/**
 * Render the daemon launchd plist as XML. Pure — no I/O.
 *
 * @param {DaemonPlistInput} input - All required fields.
 * @returns {string} Complete plist XML with trailing newline.
 */
export function renderDaemonPlist(input: DaemonPlistInput): string {
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
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(input.stdoutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(input.stderrPath)}</string>
\t<key>SessionCreate</key>
\t<true/>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>CLAUDE_MULTIACCT_ENABLE_SHIM</key>
\t\t<string>1</string>
\t</dict>
</dict>
</plist>
`;
}
