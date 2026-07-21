/**
 * Intent: PR6b's user-facing docs exist and name the key commands.
 * Adversarial: rename or remove any of the doc files → this trips.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = resolve(import.meta.dirname, "..", "..");

describe("docs presence", () => {
	it("docs/README.md exists, is non-empty, and names cma init/install/launch", async () => {
		const path = resolve(pkgRoot, "docs", "README.md");
		const st = await stat(path);
		expect(st.size).toBeGreaterThan(0);
		const contents = await readFile(path, "utf8");
		expect(contents).toContain("cma init");
		expect(contents).toContain("cma install");
		expect(contents).toContain("cma launch");
	});

	it("docs/architecture.md exists and lists PR6b in the per-PR table", async () => {
		const path = resolve(pkgRoot, "docs", "architecture.md");
		const contents = await readFile(path, "utf8");
		expect(contents.length).toBeGreaterThan(0);
		expect(contents).toContain("PR6b");
	});

	it("docs/migration-from-old-bash-tool.md exists and names --apply + reinstall fallback", async () => {
		const path = resolve(pkgRoot, "docs", "migration-from-old-bash-tool.md");
		const contents = await readFile(path, "utf8");
		expect(contents.length).toBeGreaterThan(0);
		expect(contents).toContain("--apply");
		expect(contents).toContain("reinstall");
	});
});
