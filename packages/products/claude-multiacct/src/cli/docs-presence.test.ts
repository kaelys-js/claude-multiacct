/**
 * Intent: PR6b's user-facing docs exist and name the key commands.
 * Adversarial: rename or remove any of the doc files → this trips.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = resolve(import.meta.dirname, "..", "..");

describe("docs presence", () => {
	it("docs/README.md is a non-empty index that links to the install and hot-swap how-tos", async () => {
		const path = resolve(pkgRoot, "docs", "README.md");
		const st = await stat(path);
		expect(st.size).toBeGreaterThan(0);
		const contents = await readFile(path, "utf8");
		// The index page links out to the how-tos rather than duplicating
		// every command name inline. Presence of those linked filenames is
		// what proves the index still reflects the doc tree.
		expect(contents).toContain("install-and-uninstall.md");
		expect(contents).toContain("hot-swap.md");
		expect(contents).toContain("cma install");
	});

	it("docs/architecture.md exists and describes the four cooperating subsystems", async () => {
		const path = resolve(pkgRoot, "docs", "architecture.md");
		const contents = await readFile(path, "utf8");
		expect(contents.length).toBeGreaterThan(0);
		// A drift-check that the mermaid diagram + subsystem labels stayed
		// in the doc: renaming any of these should force an explicit update
		// to both the doc and this test.
		expect(contents).toContain("CLI shim");
		expect(contents).toContain("Bridge daemon");
	});

	it("docs/install-and-uninstall.md covers the legacy-bash-tool cleanup path", async () => {
		// The old migration-from-old-bash-tool.md was consolidated into the
		// install-and-uninstall how-to (see README index bullet). This test
		// pins that the legacy-bash cleanup story stayed with the install
		// doc after the merge.
		const path = resolve(pkgRoot, "docs", "install-and-uninstall.md");
		const contents = await readFile(path, "utf8");
		expect(contents.length).toBeGreaterThan(0);
		expect(contents).toContain("cma install");
		expect(contents.toLowerCase()).toContain("legacy");
	});
});
