/**
 * `@foundation/claude-multiacct` — pure XML emitter for the react-profile
 * environment agent's launchd plist.
 *
 * # Why this agent exists
 *
 * The picker only loads because Claude Desktop's own renderer honours the
 * `REACT_PROFILE=1` environment variable: with it set, Claude calls
 * `session.loadExtension` on the planted extension (see `extension/installer.ts`
 * and `launch/wrapper.ts`). `cma launch` supplies that variable itself, but a
 * dock / Spotlight / LaunchServices open runs the bare app binary with an empty
 * environment, so `REACT_PROFILE` is absent and the picker never mounts.
 *
 * This agent closes that gap without touching `/Applications/Claude.app` (a hard
 * invariant of this codebase — see `launch/wrapper.ts`). It is a SHORT-LIVED,
 * gui-session agent whose entire job is one call: `launchctl setenv
 * REACT_PROFILE 1`. Bootstrapped into `gui/<uid>`, that call writes the variable
 * into the user's aqua launchd domain, which every GUI process the Dock or
 * Spotlight later spawns inherits — including a plain `open -a Claude`.
 * Verified 2026-07-22 on the mac mini: with this agent loaded, a bare
 * `open -a Claude` (no `--env`, no `--args`) mounts the picker.
 *
 * Distinguishing properties, and what it deliberately does NOT set:
 *
 *   - `RunAtLoad=true` — set the variable once at login so it is present in the
 *     domain before the user's first Claude launch.
 *   - `KeepAlive=false` — fire-and-forget. `launchctl setenv` mutates the domain
 *     and exits; this is not a daemon. `KeepAlive` would respawn it in a busy
 *     loop.
 *   - **No `SessionCreate`.** The whole point is to run inside the user's aqua
 *     Security session so the `setenv` lands in the domain the Dock reads from.
 *     `SessionCreate` would move it into an isolated session and the variable
 *     would never reach dock-launched apps.
 *   - **No `WatchPaths`.** The variable is decoupled from Claude.app's bundle, so
 *     a Claude auto-update cannot wipe it; there is nothing on disk to react to.
 *   - **No `EnvironmentVariables` block.** The runtime is `/bin/launchctl`, which
 *     does not consult `CLAUDE_MULTIACCT_ENABLE_SHIM`; baking the flag in here
 *     would be cargo-culted noise. The INSTALL of this agent is still gated on
 *     the flag by `agent-installer.ts`, same as the watcher and daemon.
 *
 * Values are XML-escaped defensively — user home paths can contain `&`, `<`, or
 * quotes on unusual setups.
 *
 * @module
 */

/** Canonical launchd label. Also the plist basename. */
export const REACT_PROFILE_LABEL = "com.claude-multiacct.react-profile-env";

/** Input to `renderReactProfilePlist`. All fields required. */
export type ReactProfilePlistInput = {
	label: string;
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
 * Render the react-profile environment agent's launchd plist as XML. Pure — no
 * I/O.
 *
 * Deliberately OMITS `SessionCreate`, `WatchPaths`, and `EnvironmentVariables`
 * (see module docstring): the agent must run in the user's gui Security session
 * so its `launchctl setenv` reaches dock-launched apps.
 *
 * @param {ReactProfilePlistInput} input - All required fields.
 * @returns {string} Complete plist XML with trailing newline.
 */
export function renderReactProfilePlist(input: ReactProfilePlistInput): string {
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
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(input.stdoutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`;
}
