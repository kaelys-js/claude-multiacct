/**
 * Intent: `nodeFsPort()` is the runtime binding for scan.ts — if it silently
 * drops one of the three methods (readdir/stat/exists) the watcher loses
 * classification in prod without any test noticing. Exercise all three
 * against a real tmpdir so the wiring is proven end-to-end, not just typed.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeFsPort } from "./fs-port.ts";

describe("nodeFsPort", () => {
	it("readdirSync + statSync + existsSync round-trip against a real tmpdir", () => {
		const root = mkdtempSync(join(tmpdir(), "cma-fsport-"));
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "file"), "hello");
		const port = nodeFsPort();
		expect(port.readdirSync(root).toSorted()).toStrictEqual(["file", "sub"]);
		expect(port.statSync(join(root, "sub")).isDirectory()).toBe(true);
		expect(port.statSync(join(root, "file")).size).toBe("hello".length);
		expect(port.existsSync(join(root, "file"))).toBe(true);
		expect(port.existsSync(join(root, "missing"))).toBe(false);
	});
});
