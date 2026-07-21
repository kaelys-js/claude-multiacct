/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, eslint/no-bitwise, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `config.json` reader/writer semantics. Load-bearing:
 *
 *   - Missing file → `undefined` (no throw): every CLI invocation reads
 *     config, and a fresh install has no file. Throwing would crash
 *     `cma --version`.
 *   - Corrupt / schema-invalid file → `undefined` + `logger.warn` (not
 *     throw). Rule 12 loud on the warning; Rule 2 non-fatal so a rotted
 *     sidecar can't crash the CLI.
 *   - Write validates BEFORE touching disk. Adversarial: drop the
 *     pre-write `v.parse` → the schema-invalid write test goes red.
 *   - Write is atomic (tmp+rename). Adversarial: force `rename` to throw
 *     AFTER the tmp lands → the target file is untouched.
 */

import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import type { AtomicWriteFs } from "../http-bridge/atomic-json.ts";
import {
	type CmaConfig,
	CmaConfigSchema,
	defaultConfig,
	defaultConfigPath,
	expandTilde,
	read,
	readOrDefault,
	silentLogger,
	write,
} from "./config-store.ts";

async function scratch(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "cma-cfg-"));
}

describe("config-store: defaults", () => {
	it("defaultConfigPath ends at ~/.config/claude-multiacct/config.json", () => {
		expect(defaultConfigPath()).toMatch(/\.config\/claude-multiacct\/config\.json$/u);
	});

	it("defaultConfig has enabled:false, configVersion 1, expanded paths", () => {
		const c = defaultConfig();
		expect(c.enabled).toBe(false);
		expect(c.configVersion).toBe(1);
		expect(c.logDir.startsWith("~")).toBe(false);
		expect(c.bridgeJsonPath.startsWith("~")).toBe(false);
		expect(c.logDir).toContain(".claude-multiacct/logs");
	});

	it("expandTilde('~') → homedir(); ~/x → homedir/x; anything else → unchanged", () => {
		expect(expandTilde("~")).not.toContain("~");
		expect(expandTilde("~/foo/bar")).toContain("/foo/bar");
		expect(expandTilde("/abs/path")).toBe("/abs/path");
		expect(expandTilde("relative")).toBe("relative");
	});

	it("silentLogger.warn is a no-op that returns undefined", () => {
		expect(silentLogger.warn("anything")).toBeUndefined();
	});
});

describe("config-store: read", () => {
	it("missing file → undefined; no logger warning", async () => {
		const root = await scratch();
		const warn = vi.fn();
		const result = await read(join(root, "does-not-exist.json"), { warn });
		expect(result).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	it("unreadable path (EACCES / other errno) → undefined + logger.warn", async () => {
		const warn = vi.fn();
		const readFileFn = vi
			.fn<(p: string) => Promise<string>>()
			.mockRejectedValue(
				Object.assign(new Error("boom"), { code: "EACCES" }) as NodeJS.ErrnoException,
			);
		const result = await read("/nope", { warn }, readFileFn);
		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
	});

	it("corrupted JSON → undefined + warn (does NOT throw)", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		await writeFile(path, "{not json", "utf8");
		const warn = vi.fn();
		const result = await read(path, { warn });
		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupted"));
	});

	it("schema-invalid JSON → undefined + warn (does NOT throw)", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		await writeFile(path, JSON.stringify({ enabled: "yes" }), "utf8");
		const warn = vi.fn();
		const result = await read(path, { warn });
		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("schema-invalid"));
	});

	it("valid file → parsed CmaConfig", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		const cfg: CmaConfig = defaultConfig();
		await writeFile(path, JSON.stringify(cfg), "utf8");
		const result = await read(path);
		expect(result).toStrictEqual(cfg);
	});
});

describe("config-store: readOrDefault", () => {
	it("missing file → defaults", async () => {
		const root = await scratch();
		const result = await readOrDefault(join(root, "does-not-exist.json"));
		expect(result).toStrictEqual(defaultConfig());
	});

	it("valid file → parsed value", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		const cfg: CmaConfig = { ...defaultConfig(), enabled: true };
		await writeFile(path, JSON.stringify(cfg), "utf8");
		const result = await readOrDefault(path);
		expect(result).toStrictEqual(cfg);
	});
});

describe("config-store: write", () => {
	it("writes valid config as JSON and round-trips through read", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		const cfg: CmaConfig = { ...defaultConfig(), enabled: true };
		await write(path, cfg);
		const roundtrip = await read(path);
		expect(roundtrip).toStrictEqual(cfg);
	});

	it("write validates BEFORE touching disk (schema-invalid → throws, no tmp files left)", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		const bad = { enabled: 1 } as unknown as CmaConfig;
		await expect(write(path, bad)).rejects.toThrow();
		// Adversarial tripwire — dropping the pre-write v.parse would let a tmp file appear.
		const entries = await readdir(root);
		expect(entries).toStrictEqual([]);
	});

	it("atomic: rename failure leaves target untouched (tmp-first invariant)", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		// Pre-existing file we must not clobber on a failed write.
		await writeFile(path, JSON.stringify(defaultConfig()), "utf8");

		const failingFs: AtomicWriteFs = {
			mkdir: vi.fn(async (_p, _o) => undefined),
			writeFile: vi.fn(async (p, d, o) => {
				// Actually write a tmp so we can prove tmp-first.
				await writeFile(p, d, { encoding: o.encoding, mode: o.mode });
			}),
			chmod: vi.fn(async () => undefined),
			rename: vi.fn(async () => {
				throw new Error("rename boom");
			}),
		};
		const cfg: CmaConfig = { ...defaultConfig(), enabled: true };
		await expect(write(path, cfg, failingFs)).rejects.toThrow("rename boom");

		// Target file is unchanged.
		const contents = await readFile(path, "utf8");
		expect(JSON.parse(contents)).toStrictEqual(defaultConfig());
		// A tmp file was written before the rename.
		const entries = await readdir(root);
		const tmp = entries.find((e) => e.startsWith("config.json.tmp-"));
		expect(tmp).toBeDefined();
	});

	it("uses defaultConfigPath when pathArg is undefined (delegates to real fs mock)", async () => {
		// We can't actually write to the real home; inject the fs surface.
		const calls: string[] = [];
		const mockFs: AtomicWriteFs = {
			mkdir: async () => undefined,
			writeFile: async (p) => {
				calls.push(p);
			},
			chmod: async () => undefined,
			rename: async (_from, to) => {
				calls.push(`rename→${to}`);
			},
		};
		await write(undefined, defaultConfig(), mockFs);
		const renameLine = calls.find((c) => c.startsWith("rename→"));
		expect(renameLine).toBeDefined();
		expect(renameLine).toMatch(/\.config\/claude-multiacct\/config\.json$/u);
	});

	it("write file has 0o600 mode (chmod invoked)", async () => {
		const root = await scratch();
		const path = join(root, "config.json");
		await write(path, defaultConfig());
		const s = await stat(path);
		// Owner rw only.
		const perm = s.mode & 0o777;
		expect(perm).toBe(0o600);
	});

	it("CmaConfigSchema rejects unknown top-level keys (strictObject guard)", () => {
		expect(() => v.parse(CmaConfigSchema, { ...defaultConfig(), surprise: "field" })).toThrow();
	});
});
