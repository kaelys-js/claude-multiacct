/**
 * `@foundation/claude-multiacct` — pure XML emitter for the watcher's launchd
 * agent plist.
 *
 * The plist is fed to `launchctl bootstrap gui/<uid> <plist>` by
 * `agent-installer.ts`. Its shape is load-bearing on the runtime contract:
 *
 *   - `WatchPaths` — launchd re-fires the agent whenever anything under this
 *     path changes; we watch the claude-code parent so a new sibling triggers
 *     a re-apply pass.
 *   - `RunAtLoad=false`, `KeepAlive=false` — the watcher is fire-and-forget,
 *     not a daemon. launchd only launches it on a `WatchPaths` event.
 *   - `EnvironmentVariables → CLAUDE_MULTIACCT_ENABLE_SHIM=1` — launchd's env
 *     is empty by default, so the flag must be baked in. Without it, the
 *     watcher would run under launchd but still refuse to install (flag off),
 *     and the whole PR would be a no-op in prod. The plist test asserts this
 *     variable is present.
 *
 * Values are XML-escaped defensively; users' `stdoutPath` / `stderrPath` may
 * contain characters like `&` in absolute pathnames on unusual setups.
 *
 * @module
 */

/** Canonical launchd label. Also used by `agent-installer.ts` as the plist basename. */
export const WATCHER_LABEL = "com.claude-multiacct.watcher";

/** Input to `renderWatcherPlist`. All fields required. */
export type WatcherPlistInput = {
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
 * Render the launchd agent plist as XML. Pure — no I/O.
 *
 * @param {WatcherPlistInput} input - All required fields (no defaults here;
 *   `agent-installer.ts` chooses paths).
 * @returns {string} Complete plist XML with trailing newline.
 */
export function renderWatcherPlist(input: WatcherPlistInput): string {
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
\t<false/>
\t<key>KeepAlive</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(input.stdoutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(input.stderrPath)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>CLAUDE_MULTIACCT_ENABLE_SHIM</key>
\t\t<string>1</string>
\t</dict>
</dict>
</plist>
`;
}
