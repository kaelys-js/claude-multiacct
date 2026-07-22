/**
 * Intent: the react-profile agent's plist body is a launchd contract, and it
 * has two load-bearing negatives — it must NOT carry `SessionCreate` (that would
 * move the `launchctl setenv` into an isolated Security session where dock apps
 * never see the variable) and it must NOT carry `WatchPaths` (the variable is
 * decoupled from Claude.app's bundle; there is nothing on disk to react to). The
 * byte-for-byte assertion pins key order/casing/content; the dedicated negative
 * cases are the adversarial tripwires.
 *
 * The positive keys encode the lifecycle: `RunAtLoad=true` (set the variable at
 * login, before the first Claude launch) and `KeepAlive=false` (fire-and-forget
 * — `launchctl setenv` mutates the domain and exits; it is not a daemon).
 */

import { describe, expect, it } from "vitest";
import { REACT_PROFILE_LABEL, renderReactProfilePlist } from "./launchd-plist.ts";

describe("REACT_PROFILE_LABEL", () => {
	it("is the canonical reverse-DNS label the plist filename derives from", () => {
		expect(REACT_PROFILE_LABEL).toBe("com.claude-multiacct.react-profile-env");
	});
});

describe("renderReactProfilePlist", () => {
	const xml = renderReactProfilePlist({
		label: REACT_PROFILE_LABEL,
		programArgs: ["/bin/launchctl", "setenv", "REACT_PROFILE", "1"],
		stdoutPath: "/tmp/cma-react-profile.out",
		stderrPath: "/tmp/cma-react-profile.err",
	});

	it("emits the full plist XML byte-for-byte (drift in any key trips CI)", () => {
		expect(xml).toBe(
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.claude-multiacct.react-profile-env</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/launchctl</string>
\t\t<string>setenv</string>
\t\t<string>REACT_PROFILE</string>
\t\t<string>1</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>/tmp/cma-react-profile.out</string>
\t<key>StandardErrorPath</key>
\t<string>/tmp/cma-react-profile.err</string>
</dict>
</plist>
`,
		);
	});

	it("does NOT set SessionCreate (adversarial: add it → setenv lands in an isolated session, dock apps never see it → red)", () => {
		expect(xml).not.toContain("SessionCreate");
	});

	it("does NOT set WatchPaths (the variable is decoupled from Claude.app's bundle)", () => {
		expect(xml).not.toContain("WatchPaths");
	});

	it("does NOT bake an EnvironmentVariables block (the runtime is /bin/launchctl, which never reads the flag)", () => {
		expect(xml).not.toContain("EnvironmentVariables");
	});

	it("emits RunAtLoad=true so the variable is set at login before the first Claude launch", () => {
		expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>");
	});

	it("emits KeepAlive=false — setenv is a one-shot, not a long-lived daemon", () => {
		expect(xml).toContain("<key>KeepAlive</key>\n\t<false/>");
	});

	it("carries the setenv program args (REACT_PROFILE=1 is what mounts the picker)", () => {
		expect(xml).toContain(
			"<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/bin/launchctl</string>\n\t\t<string>setenv</string>\n\t\t<string>REACT_PROFILE</string>\n\t\t<string>1</string>\n\t</array>",
		);
	});

	it("XML-escapes special characters in values (defensive: absolute paths may contain '&')", () => {
		const escaped = renderReactProfilePlist({
			label: "l&<>\"'x",
			programArgs: ["/a<b>"],
			stdoutPath: "/o&",
			stderrPath: "/e",
		});
		expect(escaped).toContain("<string>l&amp;&lt;&gt;&quot;&apos;x</string>");
		expect(escaped).toContain("<string>/a&lt;b&gt;</string>");
		expect(escaped).toContain("<string>/o&amp;</string>");
	});
});
