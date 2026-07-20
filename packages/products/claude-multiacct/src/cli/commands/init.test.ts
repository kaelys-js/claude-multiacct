/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `cma init` creates the config dir + `config.json` idempotently,
 * and never touches `registry.json` (per the Rule-1 decision in init.ts).
 * Load-bearing:
 *
 *   - Fresh dir → mkdir + write called; log message printed.
 *   - Idempotent: existing valid config → no writes, log says "already exists".
 *   - `--dry-run` writes nothing, reports intent.
 *   - Write failure → `{ok:false, reason:"write_failed"}`.
 *   - registry.json is NEVER touched (Rule 1 decision) — adversarial:
 *     add a registry write to init and this test goes red.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config-store.ts";
import { initCommand } from "./init.ts";

async function scratch(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "cma-init-"));
}

function makeLogger(): {
	log: ReturnType<typeof vi.fn<(m: string) => void>>;
	warn: ReturnType<typeof vi.fn<(m: string) => void>>;
} {
	return {
		log: vi.fn<(m: string) => void>(),
		warn: vi.fn<(m: string) => void>(),
	};
}

describe("initCommand", () => {
	it("fresh: creates dir + writes config; returns {created:true}", async () => {
		const root = await scratch();
		const path = join(root, "subdir", "config.json");
		const logger = makeLogger();
		const result = await initCommand({ configPath: path, logger });
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("unreachable");
		}
		expect(result.created).toBe(true);
		expect(result.path).toBe(path);
		const raw = await readFile(path, "utf8");
		expect(JSON.parse(raw)).toStrictEqual(defaultConfig());
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("wrote"));
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("registry.json"));
	});

	it("idempotent: existing valid config → no-op, {created:false}", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		await writeFile(path, JSON.stringify(defaultConfig()), "utf8");
		const logger = makeLogger();
		const writeSpy = vi.fn<(p: string | undefined, c: unknown) => Promise<void>>();
		const result = await initCommand({
			configPath: path,
			logger,
			writeConfig: writeSpy as unknown as (
				p: string | undefined,
				c: ReturnType<typeof defaultConfig>,
			) => Promise<void>,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("unreachable");
		}
		expect(result.created).toBe(false);
		expect(writeSpy).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("already exists"));
	});

	it("--dry-run: no fs writes, log says 'would create'", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		const logger = makeLogger();
		const mkdirSpy = vi.fn<(p: string, o: { recursive: true }) => Promise<unknown>>();
		const writeSpy = vi.fn<(p: string | undefined, c: unknown) => Promise<void>>();
		const result = await initCommand({
			configPath: path,
			dryRun: true,
			logger,
			mkdirFn: mkdirSpy,
			writeConfig: writeSpy as unknown as (
				p: string | undefined,
				c: ReturnType<typeof defaultConfig>,
			) => Promise<void>,
		});
		expect(result.ok).toBe(true);
		expect(mkdirSpy).not.toHaveBeenCalled();
		expect(writeSpy).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("would create"));
	});

	it("write failure → {ok:false, reason:'write_failed'}", async () => {
		const logger = makeLogger();
		const result = await initCommand({
			configPath: "/nope/config.json",
			logger,
			readConfig: async () => undefined,
			mkdirFn: async () => undefined,
			writeConfig: async () => {
				throw new Error("disk full");
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		expect(result.reason).toBe("write_failed");
		expect(result.detail).toBe("disk full");
	});

	it("write failure with non-Error thrown → detail is String(thrown)", async () => {
		const logger = makeLogger();
		const result = await initCommand({
			configPath: "/nope/config.json",
			logger,
			readConfig: async () => undefined,
			mkdirFn: async () => undefined,
			writeConfig: () => Promise.reject("string-not-error"),
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		expect(result.detail).toBe("string-not-error");
	});

	it("defaults: omitted configPath falls through to defaultConfigPath (delegates through injected readConfig)", async () => {
		const logger = makeLogger();
		const readSpy = vi.fn<(p?: string) => Promise<undefined>>().mockResolvedValue(undefined);
		const writeSpy = vi.fn<(p: string | undefined, c: unknown) => Promise<void>>();
		const mkdirSpy = vi.fn<(p: string, o: { recursive: true }) => Promise<unknown>>();
		const result = await initCommand({
			logger,
			readConfig: readSpy,
			writeConfig: writeSpy as unknown as (
				p: string | undefined,
				c: ReturnType<typeof defaultConfig>,
			) => Promise<void>,
			mkdirFn: mkdirSpy,
		});
		expect(result.ok).toBe(true);
		expect(readSpy).toHaveBeenCalledTimes(1);
		const [firstCall] = readSpy.mock.calls;
		if (firstCall === undefined) {
			throw new Error("unreachable — readSpy should have been called");
		}
		expect(firstCall[0]).toMatch(/\.config\/claude-multiacct\/config\.json$/u);
		expect(mkdirSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalledTimes(1);
	});

	it("Rule-1 tripwire: initCommand does NOT write registry.json anywhere on disk", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		const logger = makeLogger();
		await initCommand({ configPath: path, logger });
		// Only config.json (+ its tmp temporary during atomic write) may appear.
		// Adversarial: adding a registry write to init would place another file.
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(root);
		expect(entries).toContain("config.json");
		expect(entries).not.toContain("registry.json");
	});
});
