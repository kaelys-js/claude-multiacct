// CLI-entry coverage for `codeowners-reviewers.ts`. The programmatic
// `import { main }` path skips the top-level `if (isDirectRun()) { ... }`
// block, so the paths that decide whether the module runs on load are
// otherwise uncovered. These tests reset the module registry, stub
// `process.argv[1]` per case, mock `process.exit` to throw a sentinel, then
// dynamically re-import so v8 can attribute the top-level branches to a
// running test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HERE = import.meta.dirname;
const MODULE_PATH = resolve(HERE, "codeowners-reviewers.ts");
const NODE_BIN = process.argv[0] ?? "node";

function restoreOne(key: "FIX_SRC" | "BUNDLE_JSON", value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, key);
	} else {
		process.env[key] = value;
	}
}

describe("codeowners-reviewers direct-run entry", () => {
	const originalArgv = process.argv;
	const originalEnv = { FIX_SRC: process.env.FIX_SRC, BUNDLE_JSON: process.env.BUNDLE_JSON };
	let scratch: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "co-cli-"));
		exitCodes = [];
		// No-op exit: the module's top-level `if (isDirectRun())` block calls
		// exit at the tail of both success and failure arms. Throwing here
		// would propagate into the outer catch and rewrite exit(0) as exit(1);
		// recording without throwing lets the module finish normally so we can
		// assert on the recorded arg.
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
		restoreOne("FIX_SRC", originalEnv.FIX_SRC);
		restoreOne("BUNDLE_JSON", originalEnv.BUNDLE_JSON);
	});

	// isDirectRun() -> false via the `!entry` short-circuit. Re-import with
	// argv trimmed to just the interpreter — the top-level `if` never fires.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./codeowners-reviewers.ts`);
		expect(exitCodes).toEqual([]);
	});

	// isDirectRun() -> false via realpathSync throwing on a non-existent entry.
	// Covers the catch arm of the try/catch guarding the realpathSync compare.
	it("skips main() when argv[1] does not resolve to a real path", async () => {
		process.argv = [NODE_BIN, join(scratch, "ghost")];
		await import(`./codeowners-reviewers.ts`);
		expect(exitCodes).toEqual([]);
	});

	// Happy path: argv[1] === the module's own path, main() runs, exits 0.
	// FIX_SRC points at a dir with no CODEOWNERS, so main returns 0 without
	// needing a bundle — covers `code = await main(); process.exit(code)`.
	it("runs main() and exits with its return code on success", async () => {
		process.argv = [NODE_BIN, MODULE_PATH];
		process.env.FIX_SRC = scratch; // no CODEOWNERS => main returns 0
		process.env.BUNDLE_JSON = join(scratch, "bundle.json"); // never read
		await import(`./codeowners-reviewers.ts`);
		expect(exitCodes).toEqual([0]);
	});

	// Failure path: main throws because FIX_SRC is missing → catch arm
	// emits stderr + exits 1.
	it("catches main() errors, emits stderr, and exits 1", async () => {
		process.argv = [NODE_BIN, MODULE_PATH];
		Reflect.deleteProperty(process.env, "FIX_SRC");
		Reflect.deleteProperty(process.env, "BUNDLE_JSON");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./codeowners-reviewers.ts`);
		expect(exitCodes).toEqual([1]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("codeowners-reviewers: unexpected error");
		expect(emitted).toContain("FIX_SRC");
	});
});
