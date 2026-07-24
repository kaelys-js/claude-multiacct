/**
 * `@foundation/claude-multiacct` — pure XML emitter for the watcher's launchd
 * agent plist.
 *
 * The plist is fed to `launchctl bootstrap gui/<uid> <plist>` by
 * `agent-installer.ts`. Its shape is load-bearing on the runtime contract:
 *
 *   - `RunAtLoad=true`, `KeepAlive=true` — the watcher is a resident daemon.
 *     It boots at login and launchd restarts it if it dies. The process holds
 *     its own recursive `fs.watch` on the claude-code parent and re-plants the
 *     shim synchronously the instant Claude rewrites the `claude` binary, which
 *     is the race a spawned-per-event agent lost (it woke ~13-19s after launch,
 *     well after the session already started on the vanilla binary).
 *   - `WatchPaths` — a coarse backup. launchd still relaunches the process on a
 *     change under this path, so if the resident watch ever misses an event or
 *     the process crashed between the fire and the restart, the parent-dir
 *     change re-loads it and a catch-up pass runs.
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
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
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
