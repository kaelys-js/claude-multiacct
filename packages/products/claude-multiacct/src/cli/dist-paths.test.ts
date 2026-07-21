/**
 * Intent: the bundled `dist/cma.js` must resolve every sibling artifact
 * (extension dist dir, watcher.js, daemon.js) to the SAME `dist/` it lives
 * in. The pre-fix code used `join(fileDir(), "..", "extension")` which,
 * from `dist/cma.js`, walked up to `packages/products/claude-multiacct/`
 * and produced `.../extension` — sibling of `dist/`, NOT `dist/extension`.
 * That silently broke every real install.
 *
 * Adversarial: revert the fix (join(dir, "..", "extension")) and the
 * "dist context" cases below flip red.
 */

import { describe, expect, it } from "vitest";
import {
	resolveDaemonScriptPath,
	resolveExtensionDistDir,
	resolveWatcherScriptPath,
} from "./dist-paths.ts";

describe("resolveExtensionDistDir — bundled + src contexts", () => {
	it("bundled dist/cma.js → sibling dist/extension (Bug 2 adversarial)", () => {
		expect(resolveExtensionDistDir("file:///opt/pkg/dist/cma.js")).toBe("/opt/pkg/dist/extension");
	});

	it("src/cli/wiring.ts → up-two-levels dist/extension (dev/test)", () => {
		expect(resolveExtensionDistDir("file:///opt/pkg/src/cli/wiring.ts")).toBe(
			"/opt/pkg/dist/extension",
		);
	});
});

describe("resolveWatcherScriptPath — bundled + src contexts", () => {
	it("bundled dist/cma.js → sibling dist/watcher.js", () => {
		expect(resolveWatcherScriptPath("file:///opt/pkg/dist/cma.js")).toBe(
			"/opt/pkg/dist/watcher.js",
		);
	});

	it("src/cli/wiring.ts → up-two-levels dist/watcher.js", () => {
		expect(resolveWatcherScriptPath("file:///opt/pkg/src/cli/wiring.ts")).toBe(
			"/opt/pkg/dist/watcher.js",
		);
	});
});

describe("resolveDaemonScriptPath — bundled + src contexts", () => {
	it("bundled dist/cma.js → sibling dist/daemon.js", () => {
		expect(resolveDaemonScriptPath("file:///opt/pkg/dist/cma.js")).toBe("/opt/pkg/dist/daemon.js");
	});

	it("src/cli/wiring.ts → up-two-levels dist/daemon.js", () => {
		expect(resolveDaemonScriptPath("file:///opt/pkg/src/cli/wiring.ts")).toBe(
			"/opt/pkg/dist/daemon.js",
		);
	});
});
