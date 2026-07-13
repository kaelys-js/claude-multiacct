// CLI-entry coverage for `apply-bundle.ts`. Covers the top-level
// `invokedDirectly` block's `.then(exit)` and `.catch(exit(1))` arms that
// the programmatic `import { main }` path skips. Uses the shared
// resetModules + dynamic-import pattern.
//
// The module under test mocks `@foundation/shell` in its dedicated
// *.test.ts sibling; that hoist is per-test-file, so this file re-declares
// the mock so a dynamic re-import of the module resolves to the same
// stubbed `sh`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFsTypes from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@foundation/shell", () => ({
	sh: vi.fn<() => Promise<unknown>>(),
}));

const HERE = import.meta.dirname;
const MODULE_PATH = resolvePath(HERE, "apply-bundle.ts");
const NODE_BIN = process.argv[0] ?? "node";
const ENV_KEYS = ["BUNDLE_JSON", "FIX_SRC", "TASK_ID_SLUG"] as const;

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

// A single tick on the microtask/macrotask boundary — used to let the module's
// top-level `main().then(...).catch(...)` chain settle before we assert.
async function flushImmediate(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

describe("apply-bundle direct-run entry", () => {
	const originalArgv = process.argv;
	const originalEnv: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) {
		originalEnv[k] = process.env[k];
	}
	let scratch: string;
	let origCwd: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "ab-cli-"));
		mkdirSync(join(scratch, "discovery/patches"), { recursive: true });
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

	// invokedDirectly === false path (argv[1] undefined).
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./apply-bundle.ts`);
		await flushImmediate();
		expect(exitCodes).toEqual([]);
	});

	// invokedDirectly === true, main resolves 0 (Path Y full-content write)
	// → .then arm calls exit(0).
	it(".then arm calls exit(0) when main resolves 0 (Path Y success)", async () => {
		const fixSrc = join(scratch, "src");
		mkdirSync(fixSrc, { recursive: true });
		const bundlePath = join(scratch, "bundle.json");
		writeFileSync(
			bundlePath,
			JSON.stringify({
				files_to_modify: [{ path: "hello.ts", full_content: "// hi\n" }],
			}),
		);
		process.env.BUNDLE_JSON = bundlePath;
		process.env.FIX_SRC = fixSrc;
		process.env.TASK_ID_SLUG = "sec-cli-ok";
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./apply-bundle.ts`);
		// main is async; the .then handler on the returned promise fires on
		// the microtask queue after the top-level `if` scheduled it.
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([0]);
	});

	// invokedDirectly === true, main throws synchronously (bad JSON.parse)
	// → the returned promise rejects → .catch arm writes stderr + exit(1).
	it(".catch arm writes stderr and calls exit(1) when main() throws", async () => {
		// BUNDLE_JSON points at a file whose contents aren't valid JSON —
		// JSON.parse throws inside main(), the returned promise rejects.
		const bundlePath = join(scratch, "bundle.json");
		writeFileSync(bundlePath, "not-json");
		process.env.BUNDLE_JSON = bundlePath;
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-cli-fail";
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./apply-bundle.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
	});

	// The catch block's `error instanceof Error ? ... : String(error)` branch
	// only exercises the false arm when something other than a real Error is
	// thrown out of main(). readFileSync normally only throws Error/Errno
	// exceptions, so we mock node:fs to prove the fallback stringification
	// path holds for a thrown non-Error value.
	it(".catch arm stringifies a thrown non-Error value instead of reading .stack", async () => {
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
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-cli-nonerror";
		process.argv = [NODE_BIN, MODULE_PATH];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./apply-bundle.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
		expect(
			stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes("boom-not-an-error")),
		).toBe(true);
		vi.doUnmock("node:fs");
	});

	// The `error.stack ?? error.message` fallback only exercises its false
	// arm when a real Error instance is thrown with a falsy `.stack`.
	it(".catch arm falls back to error.message when a thrown Error has no stack", async () => {
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
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-cli-nostack";
		process.argv = [NODE_BIN, MODULE_PATH];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./apply-bundle.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
		expect(stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes("stackless-boom"))).toBe(
			true,
		);
		vi.doUnmock("node:fs");
	});
});
