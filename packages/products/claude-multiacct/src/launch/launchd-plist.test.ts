/**
 * Intent: the daemon plist's four distinguishing keys are load-bearing on
 * the runtime story:
 *
 *  - `RunAtLoad=true` — service starts at login; the extension does not
 *    have to launch the daemon on demand.
 *  - `KeepAlive=true` — a crashed daemon is auto-relaunched.
 *  - `EnvironmentVariables.CLAUDE_MULTIACCT_ENABLE_SHIM=1` — without
 *    this, launchd runs the daemon under an empty env and every
 *    mutating request would be 403'd. Adversarial: drop this key →
 *    the corresponding test flips red.
 *  - `Label = com.claude-multiacct.bridge-daemon` — same identity all
 *    tooling (launchctl bootstrap/bootout, status) uses.
 *
 * Values are XML-escaped: a path with `&` must not corrupt the plist.
 */

import { describe, expect, it } from "vitest";
import { DAEMON_LABEL, renderDaemonPlist } from "./launchd-plist.ts";

describe("renderDaemonPlist", () => {
	const sample = renderDaemonPlist({
		label: DAEMON_LABEL,
		programArgs: ["/usr/bin/node", "/opt/dist/daemon.js"],
		stdoutPath: "/home/u/.claude-multiacct/logs/daemon.out",
		stderrPath: "/home/u/.claude-multiacct/logs/daemon.err",
	});

	it("emits RunAtLoad=true (a false here would delay the daemon until first request)", () => {
		expect(sample).toContain("<key>RunAtLoad</key>\n\t<true/>");
	});

	it("emits KeepAlive=true (a false here would let a crash permanently kill the service)", () => {
		expect(sample).toContain("<key>KeepAlive</key>\n\t<true/>");
	});

	it("bakes in CLAUDE_MULTIACCT_ENABLE_SHIM=1 (drop → RED)", () => {
		expect(sample).toContain("<key>CLAUDE_MULTIACCT_ENABLE_SHIM</key>");
		expect(sample).toContain("<string>1</string>");
	});

	it("includes the canonical label", () => {
		expect(sample).toContain(`<string>${DAEMON_LABEL}</string>`);
		expect(DAEMON_LABEL).toBe("com.claude-multiacct.bridge-daemon");
	});

	it("emits the log paths", () => {
		expect(sample).toContain("/home/u/.claude-multiacct/logs/daemon.out");
		expect(sample).toContain("/home/u/.claude-multiacct/logs/daemon.err");
	});

	it("XML-escapes special characters in paths", () => {
		const escaped = renderDaemonPlist({
			label: DAEMON_LABEL,
			programArgs: ["/node & fun"],
			stdoutPath: "/o<ut>",
			stderrPath: "/err\"'",
		});
		expect(escaped).toContain("/node &amp; fun");
		expect(escaped).toContain("/o&lt;ut&gt;");
		expect(escaped).toContain("/err&quot;&apos;");
	});
});
