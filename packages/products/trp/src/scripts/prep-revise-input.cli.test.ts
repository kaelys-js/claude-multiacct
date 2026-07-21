// CLI-entry coverage for `prep-revise-input.ts` — resets modules, retargets
// argv[1], stubs process.exit to a no-op recorder, and dynamically imports
// so the top-level `if (isDirectRun())` branches attribute to a test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HERE = import.meta.dirname;
const MODULE_PATH = resolve(HERE, "prep-revise-input.ts");
const NODE_BIN = process.argv[0] ?? "node";
const ENV_KEYS = ["TASK_ID_SLUG", "REPO_SLUG", "FAIL_JSON"] as const;

function clearEnv(keys: readonly string[]): void {
	for (const k of keys) {
		Reflect.deleteProperty(process.env, k);
	}
}

function restoreEnv(
	keys: readonly string[],
	orig: Readonly<Record<string, string | undefined>>,
): void {
	for (const k of keys) {
		const v = orig[k];
		if (v === undefined) {
			Reflect.deleteProperty(process.env, k);
		} else {
			process.env[k] = v;
		}
	}
}

describe("prep-revise-input direct-run entry", () => {
	const originalArgv = process.argv;
	const originalEnv: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) {
		originalEnv[k] = process.env[k];
	}
	let scratch: string;
	let origCwd: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pri-cli-"));
		origCwd = process.cwd();
		process.chdir(scratch);
		exitCodes = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.chdir(origCwd);
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
		restoreEnv(ENV_KEYS, originalEnv);
	});

	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./prep-revise-input.ts`);
		expect(exitCodes).toEqual([]);
	});

	it("skips main() when argv[1] cannot be realpath'd", async () => {
		process.argv = [NODE_BIN, join(scratch, "ghost")];
		await import(`./prep-revise-input.ts`);
		expect(exitCodes).toEqual([]);
	});

	// Direct-run: TASK_ID_SLUG missing → main returns 2 (soft failure). Covers
	// `code = await main(); process.exit(code)` with a non-zero exit code.
	it("runs main() and exits with its return code (soft failure)", async () => {
		clearEnv(ENV_KEYS);
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./prep-revise-input.ts`);
		// main() writes an error to stderr and returns 2 when TASK_ID_SLUG
		// is missing — the CLI entry then calls process.exit(2).
		expect(exitCodes).toEqual([2]);
	});

	// Direct-run: force main() to throw by mocking a required import to
	// blow up. Simplest angle — set TASK_ID_SLUG but no candidate fail JSON;
	// main still returns 2 (not throw). To hit the outer catch, chdir to a
	// dir that doesn't exist so relative fs calls throw.
	it("catches main() errors, emits stderr, and exits 1", async () => {
		// chdir into scratch, then rm it out from under us so any relative
		// path operation the module attempts throws. Node returns ENOENT on
		// cwd calls after the dir is deleted.
		process.env.TASK_ID_SLUG = "sec-x";
		Reflect.deleteProperty(process.env, "REPO_SLUG");
		Reflect.deleteProperty(process.env, "FAIL_JSON");
		const gone = join(tmpdir(), `pri-cli-gone-${Date.now()}-${Math.random()}`);
		rmSync(gone, { recursive: true, force: true });
		process.chdir(tmpdir());
		process.argv = [NODE_BIN, MODULE_PATH];
		// Force a synchronous fs failure by pointing FAIL_JSON at an unreadable
		// path (a directory), so JSON.parse(readFileSync(...)) throws EISDIR.
		process.env.FAIL_JSON = tmpdir();
		await import(`./prep-revise-input.ts`);
		expect(exitCodes).toEqual([1]);
	});
});
