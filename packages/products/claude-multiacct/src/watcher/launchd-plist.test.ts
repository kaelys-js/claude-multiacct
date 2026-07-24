/**
 * Intent: the plist body is what launchd contracts on — a typo in a key or a
 * missing `EnvironmentVariables` entry silently breaks the watcher (agent
 * loads but never runs the shim install because the flag isn't set). This
 * test pins the entire emitted XML byte-for-byte, so any drift in key order,
 * casing, or content trips CI before the plist reaches a user's launchd.
 *
 * Adversarial: change `WATCHER_LABEL` or drop the `CLAUDE_MULTIACCT_ENABLE_SHIM`
 * env entry and the exact-match assertion flips red.
 */

import { describe, expect, it } from "vitest";
import { renderWatcherPlist, WATCHER_LABEL } from "./launchd-plist.ts";

describe("WATCHER_LABEL", () => {
	it("is the canonical reverse-DNS label the plist filename derives from", () => {
		expect(WATCHER_LABEL).toBe("com.claude-multiacct.watcher");
	});
});

describe("renderWatcherPlist", () => {
	it("emits the full plist XML with the load-bearing fields (label, WatchPaths, env flag)", () => {
		const xml = renderWatcherPlist({
			label: WATCHER_LABEL,
			watchedPath: "/Users/alice/Library/Application Support/Claude/claude-code",
			programArgs: ["/usr/local/bin/node", "/Users/alice/dist/watcher.js"],
			stdoutPath: "/tmp/cma-watcher.out",
			stderrPath: "/tmp/cma-watcher.err",
		});
		expect(xml).toBe(
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.claude-multiacct.watcher</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/local/bin/node</string>
\t\t<string>/Users/alice/dist/watcher.js</string>
\t</array>
\t<key>WatchPaths</key>
\t<array>
\t\t<string>/Users/alice/Library/Application Support/Claude/claude-code</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>/tmp/cma-watcher.out</string>
\t<key>StandardErrorPath</key>
\t<string>/tmp/cma-watcher.err</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>CLAUDE_MULTIACCT_ENABLE_SHIM</key>
\t\t<string>1</string>
\t</dict>
</dict>
</plist>
`,
		);
	});

	it("XML-escapes special characters in values (defensive: absolute paths may contain '&')", () => {
		const xml = renderWatcherPlist({
			label: "l&<>\"'x",
			watchedPath: "/w&p",
			programArgs: ["/a<b>"],
			stdoutPath: "/o",
			stderrPath: "/e",
		});
		expect(xml).toContain("<string>l&amp;&lt;&gt;&quot;&apos;x</string>");
		expect(xml).toContain("<string>/w&amp;p</string>");
		expect(xml).toContain("<string>/a&lt;b&gt;</string>");
	});
});
