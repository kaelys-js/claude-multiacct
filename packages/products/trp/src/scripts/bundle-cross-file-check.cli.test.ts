// CLI-entry coverage for `bundle-cross-file-check.ts`. Follows the
// resetModules + dynamic-import pattern used by the sibling *.cli.test.ts
// files. Covers the top-level `if (invokedDirectly)` block that the
// programmatic `import { main }` path skips.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFsTypes from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HERE = import.meta.dirname;
const MODULE_PATH = resolve(HERE, "bundle-cross-file-check.ts");
const NODE_BIN = process.argv[0] ?? "node";
const ENV_KEYS = ["BUNDLE_JSON", "TASK_ID_SLUG"] as const;

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

describe("bundle-cross-file-check direct-run entry", () => {
	const originalArgv = process.argv;
	const originalEnv: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) {
		originalEnv[k] = process.env[k];
	}
	let scratch: string;
	let origCwd: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "bxfc-cli-"));
		mkdirSync(join(scratch, "discovery"), { recursive: true });
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

	// invokedDirectly === false because argv[1] is undefined.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./bundle-cross-file-check.ts`);
		expect(exitCodes).toEqual([]);
	});

	// invokedDirectly === true, main resolves 0 → exit(0). Empty bundle
	// yields zero findings and the PASS return code.
	it("runs main() and exits 0 on a clean bundle", async () => {
		const bundlePath = join(scratch, "bundle.json");
		writeFileSync(bundlePath, JSON.stringify({ files_to_modify: [] }));
		process.env.BUNDLE_JSON = bundlePath;
		process.env.TASK_ID_SLUG = "sec-cli-ok";
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./bundle-cross-file-check.ts`);
		expect(exitCodes).toEqual([0]);
	});

	// invokedDirectly === true, main throws (missing env) → catch → exit(1).
	it("catches main() errors, emits stderr, and exits 1 on missing env", async () => {
		clearEnv(ENV_KEYS);
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./bundle-cross-file-check.ts`);
		expect(exitCodes).toEqual([1]);
	});

	// The catch block's `error instanceof Error ? ... : String(error)` branch
	// only exercises the false arm when something other than a real Error is
	// thrown out of main(). readFileSync normally only throws Error/Errno
	// exceptions, so we mock node:fs to prove the fallback stringification
	// path holds for a thrown non-Error value.
	it("stringifies a thrown non-Error value instead of reading .stack", async () => {
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof NodeFsTypes>();
			return {
				...actual,
				readFileSync: vi.fn<() => never>(() => {
					// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error to exercise the fallback branch
					throw "boom-not-an-error";
				}),
			};
		});
		const bundlePath = join(scratch, "bundle.json");
		writeFileSync(bundlePath, JSON.stringify({ files_to_modify: [] }));
		process.env.BUNDLE_JSON = bundlePath;
		process.env.TASK_ID_SLUG = "sec-cli-nonerror";
		process.argv = [NODE_BIN, MODULE_PATH];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./bundle-cross-file-check.ts`);
		expect(exitCodes).toEqual([1]);
		expect(
			stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes("boom-not-an-error")),
		).toBe(true);
		vi.doUnmock("node:fs");
	});

	// The `error.stack ?? error.message` fallback only exercises its false
	// arm when a real Error instance is thrown with a falsy `.stack`.
	it("falls back to error.message when a thrown Error has no stack", async () => {
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof NodeFsTypes>();
			return {
				...actual,
				readFileSync: vi.fn<() => never>(() => {
					const err = new Error("stackless-boom");
					err.stack = undefined;
					throw err;
				}),
			};
		});
		const bundlePath = join(scratch, "bundle.json");
		writeFileSync(bundlePath, JSON.stringify({ files_to_modify: [] }));
		process.env.BUNDLE_JSON = bundlePath;
		process.env.TASK_ID_SLUG = "sec-cli-nostack";
		process.argv = [NODE_BIN, MODULE_PATH];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./bundle-cross-file-check.ts`);
		expect(exitCodes).toEqual([1]);
		expect(stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes("stackless-boom"))).toBe(
			true,
		);
		vi.doUnmock("node:fs");
	});
});
