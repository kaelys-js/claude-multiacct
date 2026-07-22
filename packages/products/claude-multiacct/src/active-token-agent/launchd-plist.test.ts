/**
 * Intent: the companion's plist body is a launchd contract, and its ONE
 * load-bearing property is a negative — it must NOT carry `SessionCreate`. That
 * absence is the entire reason the agent exists: with `SessionCreate` it would
 * run in an isolated Security session and, exactly like the daemon, fail to read
 * the login keychain, so it could never resolve the active account. The
 * byte-for-byte assertion pins key order/casing/content; the dedicated
 * `SessionCreate` case is the adversarial tripwire (add the key → red).
 *
 * The other three keys encode the lifecycle: `RunAtLoad=true` (seed the IPC file
 * at login), `WatchPaths=[config.json]` (re-resolve when Claude rewrites it on
 * an account switch), `KeepAlive=false` (fire-and-forget, not a daemon).
 */

import { describe, expect, it } from "vitest";
import { ACTIVE_TOKEN_LABEL, renderActiveTokenPlist } from "./launchd-plist.ts";

describe("ACTIVE_TOKEN_LABEL", () => {
	it("is the canonical reverse-DNS label the plist filename derives from", () => {
		expect(ACTIVE_TOKEN_LABEL).toBe("com.claude-multiacct.active-token");
	});
});

describe("renderActiveTokenPlist", () => {
	const xml = renderActiveTokenPlist({
		label: ACTIVE_TOKEN_LABEL,
		watchedPath: "/Users/alice/Library/Application Support/Claude/config.json",
		programArgs: ["/usr/local/bin/node", "/Users/alice/.claude-multiacct/active-token.js"],
		stdoutPath: "/tmp/cma-active-token.out",
		stderrPath: "/tmp/cma-active-token.err",
	});

	it("emits the full plist XML byte-for-byte (drift in any key trips CI)", () => {
		expect(xml).toBe(
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.claude-multiacct.active-token</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/local/bin/node</string>
\t\t<string>/Users/alice/.claude-multiacct/active-token.js</string>
\t</array>
\t<key>WatchPaths</key>
\t<array>
\t\t<string>/Users/alice/Library/Application Support/Claude/config.json</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>/tmp/cma-active-token.out</string>
\t<key>StandardErrorPath</key>
\t<string>/tmp/cma-active-token.err</string>
</dict>
</plist>
`,
		);
	});

	it("does NOT set SessionCreate (adversarial: add it → the agent goes keychain-blind → red)", () => {
		expect(xml).not.toContain("SessionCreate");
	});

	it("emits RunAtLoad=true so the IPC file is seeded at login without waiting for a change", () => {
		expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>");
	});

	it("emits KeepAlive=false — the resolver is fire-and-forget, not a long-lived daemon", () => {
		expect(xml).toContain("<key>KeepAlive</key>\n\t<false/>");
	});

	it("watches Claude's config.json so an account switch re-fires the resolver", () => {
		expect(xml).toContain(
			"<key>WatchPaths</key>\n\t<array>\n\t\t<string>/Users/alice/Library/Application Support/Claude/config.json</string>",
		);
	});

	it("XML-escapes special characters in values (defensive: absolute paths may contain '&')", () => {
		const escaped = renderActiveTokenPlist({
			label: "l&<>\"'x",
			watchedPath: "/w&p",
			programArgs: ["/a<b>"],
			stdoutPath: "/o",
			stderrPath: "/e",
		});
		expect(escaped).toContain("<string>l&amp;&lt;&gt;&quot;&apos;x</string>");
		expect(escaped).toContain("<string>/w&amp;p</string>");
		expect(escaped).toContain("<string>/a&lt;b&gt;</string>");
	});
});
