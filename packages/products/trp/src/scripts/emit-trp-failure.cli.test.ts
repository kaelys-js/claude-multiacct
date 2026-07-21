// CLI-entry coverage for `emit-trp-failure.ts`. Mirrors the direct-run
// coverage pattern used for codeowners-reviewers: reset the module
// registry, retarget process.argv[1], mock process.exit as a no-op
// recorder, then dynamically re-import so v8 attributes the top-level
// `if (isDirectRun()) { ... }` branches to a running test.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HERE = import.meta.dirname;
const MODULE_PATH = resolve(HERE, "emit-trp-failure.ts");
const NODE_BIN = process.argv[0] ?? "node";
const ENV_KEYS = [
	"LOG_PATH",
	"BUNDLE_JSON",
	"OUT_PATH",
	"STAGE_LABEL",
	"FAILING_CMD",
	"ATTEMPT",
] as const;

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

describe("emit-trp-failure direct-run entry", () => {
	const originalArgv = process.argv;
	const originalEnv: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) {
		originalEnv[k] = process.env[k];
	}
	let scratch: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "etf-cli-"));
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
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
		restoreEnv(ENV_KEYS, originalEnv);
	});

	// isDirectRun -> false via !entry: module top-level does nothing.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./emit-trp-failure.ts`);
		expect(exitCodes).toEqual([]);
	});

	// isDirectRun -> false via realpathSync catch on a non-existent entry.
	it("skips main() when argv[1] cannot be realpath'd", async () => {
		process.argv = [NODE_BIN, join(scratch, "ghost")];
		await import(`./emit-trp-failure.ts`);
		expect(exitCodes).toEqual([]);
	});

	// Direct-run happy path: env is complete, main returns 0, exit(0).
	// Covers `const code = await main(); process.exit(code)`.
	it("runs main() and exits with its return code on a valid env", async () => {
		const logPath = join(scratch, "run.log");
		const bundlePath = join(scratch, "bundle.json");
		const outPath = join(scratch, "out.json");
		writeFileSync(logPath, "line1\nline2\nboom cmd\ntail\n");
		writeFileSync(bundlePath, JSON.stringify({ files_to_modify: [] }));
		clearEnv(ENV_KEYS);
		process.env.LOG_PATH = logPath;
		process.env.BUNDLE_JSON = bundlePath;
		process.env.OUT_PATH = outPath;
		process.env.STAGE_LABEL = "Stage F: lint";
		process.env.FAILING_CMD = "pnpm run lint";
		process.env.ATTEMPT = "1";
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./emit-trp-failure.ts`);
		expect(exitCodes).toEqual([0]);
	});

	// Direct-run failure path: env is missing → main throws → outer catch
	// writes stderr and exits 1.
	it("catches main() errors, emits stderr, and exits 1", async () => {
		clearEnv(ENV_KEYS);
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./emit-trp-failure.ts`);
		expect(exitCodes).toEqual([1]);
	});
});
