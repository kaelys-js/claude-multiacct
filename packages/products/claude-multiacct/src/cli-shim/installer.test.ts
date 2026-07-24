/**
 * Intent: PR2 is GATED — landing it must NOT change default behavior. The
 * flag-off tests are the load-bearing assertion: without
 * CLAUDE_MULTIACCT_ENABLE_SHIM=1 (or an explicit test override), `install`
 * and `uninstall` are must-be no-ops. Adversarial: mutate the installer to
 * ignore the flag and the flag-off tests immediately go red.
 *
 * The idempotency + snapshot + restore tests then pin the install-time
 * mechanics: `claude` → `claude.real`, new shim in place, chmod +x,
 * codesigned. Second install → no-op unless `{force:true}`.
 */

import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultBackupRoot,
	defaultShimSourcePath,
	FLAG_ENABLED_VALUE,
	FLAG_ENV_VAR,
	install,
	resolveShimSourcePathFrom,
	silentInstallerLogger,
	status,
	uninstall,
} from "./installer.ts";

type Ctx = {
	cliDir: string;
	shimSource: string;
	backupRoot: string;
	execCalls: Array<{ file: string; args: readonly string[] }>;
	logInfo: ReturnType<typeof vi.fn>;
	logWarn: ReturnType<typeof vi.fn>;
	deps: {
		execFile: (
			file: string,
			args: readonly string[],
		) => Promise<{ stdout: string; stderr: string }>;
		env: Record<string, string | undefined>;
		backupRoot: string;
		logger: { info: (m: string) => void; warn: (m: string) => void };
	};
};

async function makeCtx(flagOn: boolean): Promise<Ctx> {
	const root = await mkdtemp(join(tmpdir(), "cma-install-"));
	const cliDir = join(root, "MacOS");
	await mkdir(cliDir, { recursive: true });
	// Fake stock CLI + version marker.
	const claude = join(cliDir, "claude");
	await writeFile(claude, '#!/bin/sh\necho real-claude "$@"\n', "utf8");
	await chmod(claude, 0o755);
	await writeFile(join(cliDir, ".verified-1.2.3"), "", "utf8");

	const shimSource = join(root, "shim.js");
	await writeFile(shimSource, "#!/usr/bin/env node\nconsole.log('shim')\n", "utf8");

	const execCalls: Array<{ file: string; args: readonly string[] }> = [];
	const logInfo = vi.fn<(message: string) => void>();
	const logWarn = vi.fn<(message: string) => void>();
	return {
		cliDir,
		shimSource,
		backupRoot: join(root, "backups"),
		execCalls,
		logInfo,
		logWarn,
		deps: {
			execFile: (file, args) => {
				execCalls.push({ file, args });
				return Promise.resolve({ stdout: "", stderr: "" });
			},
			env: flagOn ? { [FLAG_ENV_VAR]: FLAG_ENABLED_VALUE } : {},
			backupRoot: join(root, "backups"),
			logger: { info: logInfo, warn: logWarn },
		},
	};
}

// Exec-call shape recorded by the fake `execFile`.
type ExecCall = { file: string; args: readonly string[] };
// Module-scope predicates keep the logical checks out of the test bodies
// (oxlint vitest/no-conditional-tests forbids conditionals inside `it`).
const isCodesign = (c: ExecCall): boolean => c.file === "codesign";
const isUnlockAny = (c: ExecCall): boolean => c.file === "chflags" && c.args[0] === "nouchg";
const isLock =
	(path: string) =>
	(c: ExecCall): boolean =>
		c.file === "chflags" && c.args[0] === "uchg" && c.args[1] === path;

describe("silentInstallerLogger — the no-op default the runtime binds", () => {
	it("info + warn are callable no-ops (default-arg contract)", () => {
		expect(() => silentInstallerLogger.info("x")).not.toThrow();
		expect(() => silentInstallerLogger.warn("x")).not.toThrow();
	});
});

describe("defaultBackupRoot — the fallback path all mutating ops write into", () => {
	it("resolves under ~/.claude-multiacct-backups (the documented convention)", () => {
		expect(defaultBackupRoot()).toMatch(/\.claude-multiacct-backups$/u);
	});
});

describe("status — always runs regardless of feature flag (read-only)", () => {
	it("reports installed=false on a fresh dir with only a stock claude binary", async () => {
		const ctx = await makeCtx(false);
		const s = await status(ctx.cliDir);
		expect(s).toStrictEqual({ installed: false, hasShim: true, hasReal: false });
	});

	it("reports installed=true after install (uses .real presence as the signal)", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource, overrideFlag: true }, ctx.deps);
		expect(await status(ctx.cliDir)).toStrictEqual({
			installed: true,
			hasShim: true,
			hasReal: true,
		});
	});
});

describe("install — feature-flag gate (LOAD-BEARING for PR2's default-off contract)", () => {
	it("with CLAUDE_MULTIACCT_ENABLE_SHIM unset → returns {skipped:true} and writes NOTHING", async () => {
		// Adversarial: if the installer starts ignoring the flag, this test goes
		// red instantly. The whole point of this PR being gated is captured here.
		const ctx = await makeCtx(false);
		const beforeFiles = await readdir(ctx.cliDir);
		const result = await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		expect(result).toStrictEqual({
			skipped: true,
			reason: expect.stringMatching(/CLAUDE_MULTIACCT_ENABLE_SHIM/u),
		});
		const afterFiles = await readdir(ctx.cliDir);
		expect(afterFiles.toSorted()).toStrictEqual(beforeFiles.toSorted());
		expect(ctx.execCalls).toStrictEqual([]);
		expect(ctx.logWarn).toHaveBeenCalledWith(expect.stringMatching(/refusing to modify/u));
	});

	it("with flag set to '1' → runs the install", async () => {
		const ctx = await makeCtx(true);
		const result = await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		expect(result).toMatchObject({ skipped: false, installed: true, alreadyInstalled: false });
	});

	it("with flag set to a WRONG value ('true') → still skipped (only '1' arms it)", async () => {
		const ctx = await makeCtx(false);
		ctx.deps.env[FLAG_ENV_VAR] = "true";
		const result = await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		expect(result).toMatchObject({ skipped: true });
	});

	it("with {overrideFlag:true} (test knob) → runs even without the env var", async () => {
		const ctx = await makeCtx(false);
		const result = await install(
			ctx.cliDir,
			{ shimSourcePath: ctx.shimSource, overrideFlag: true },
			ctx.deps,
		);
		expect(result).toMatchObject({ skipped: false });
	});
});

describe("install — mechanics", () => {
	let ctx: Ctx;
	beforeEach(async () => {
		ctx = await makeCtx(true);
	});

	it("renames claude → claude.real, writes shim as claude, chmod +x, codesign", async () => {
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const claudeStat = await stat(join(ctx.cliDir, "claude"));
		const realStat = await stat(join(ctx.cliDir, "claude.real"));
		expect(realStat.isFile()).toBe(true);
		expect(claudeStat.isFile()).toBe(true);
		// mode bits: at least owner-execute (owner octal digit is odd when x-bit set)
		expect(claudeStat.mode.toString(8).at(-3)).toMatch(/[1357]/u);
		// new claude content matches the shim source
		const claudeContent = await readFile(join(ctx.cliDir, "claude"), "utf8");
		expect(claudeContent).toBe(await readFile(ctx.shimSource, "utf8"));
		// stock CLI content moved to claude.real
		const realContent = await readFile(join(ctx.cliDir, "claude.real"), "utf8");
		expect(realContent).toContain("real-claude");
		// codesign called with ad-hoc identity on the new shim
		expect(ctx.execCalls).toContainEqual({
			file: "codesign",
			args: ["--force", "--sign", "-", join(ctx.cliDir, "claude")],
		});
	});

	it("preserves the .verified-<ver> marker (install-time marker, must survive)", async () => {
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const files = await readdir(ctx.cliDir);
		expect(files).toContain(".verified-1.2.3");
	});

	it("snapshots the pre-install claude to <backupRoot>/<ts>/claude", async () => {
		const result = await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		expect(result).toMatchObject({ skipped: false });
		const ok = result as Extract<typeof result, { skipped: false }>;
		expect(ok.backup).toBeDefined();
		const files = await readdir(ok.backup as string);
		expect(files).toContain("claude");
	});

	it("second install without force → no-op with alreadyInstalled=true (idempotent)", async () => {
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const secondCalls = ctx.execCalls.length;
		const result = await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		expect(result).toMatchObject({ skipped: false, alreadyInstalled: true });
		expect(ctx.execCalls.length).toBe(secondCalls); // no additional codesign
	});

	it("second install WITH {force:true} → reinstalls cleanly (shim replaced, .real still points at stock)", async () => {
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const newerShim = join(ctx.cliDir, "..", "shim-v2.js");
		await writeFile(newerShim, "#!/usr/bin/env node\nconsole.log('shim-v2')\n", "utf8");
		const result = await install(ctx.cliDir, { shimSourcePath: newerShim, force: true }, ctx.deps);
		expect(result).toMatchObject({ skipped: false });
		const claudeContent = await readFile(join(ctx.cliDir, "claude"), "utf8");
		expect(claudeContent).toContain("shim-v2");
		const realContent = await readFile(join(ctx.cliDir, "claude.real"), "utf8");
		expect(realContent).toContain("real-claude"); // stock preserved across force reinstall
	});

	it("throws if no CLI binary is present (nothing to swap — fail loud)", async () => {
		// Remove the stock binary AND set up an "empty" MacOS/ dir.
		const emptyDir = await mkdtemp(join(tmpdir(), "cma-empty-"));
		await expect(
			install(emptyDir, { shimSourcePath: ctx.shimSource, overrideFlag: true }, ctx.deps),
		).rejects.toThrow(/no CLI binary found/u);
	});
});

describe("install / uninstall — immutability (uchg lock, the install-race fix)", () => {
	// Intent: Claude Desktop re-materializes the bundle on launch and would
	// overwrite the planted shim; `chflags uchg` on BOTH binaries is what makes
	// the plant survive. Adversarial: drop the lock calls and the "locks both"
	// test goes red; drop the pre-mutate unlock and a real force reinstall would
	// fail on the immutable bit (modelled here by asserting the nouchg calls
	// precede the swap).
	it("fresh install locks BOTH claude and claude.real with `chflags uchg`", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		expect(ctx.execCalls).toContainEqual({
			file: "chflags",
			args: ["uchg", join(ctx.cliDir, "claude")],
		});
		expect(ctx.execCalls).toContainEqual({
			file: "chflags",
			args: ["uchg", join(ctx.cliDir, "claude.real")],
		});
	});

	it("real is locked AFTER codesign so the sign write is not itself blocked", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const codesignAt = ctx.execCalls.findIndex(isCodesign);
		const lockClaudeAt = ctx.execCalls.findIndex(isLock(join(ctx.cliDir, "claude")));
		expect(codesignAt).toBeGreaterThanOrEqual(0);
		expect(lockClaudeAt).toBeGreaterThan(codesignAt);
	});

	it("force reinstall clears `uchg` on both before re-swapping (nouchg precedes codesign)", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const boundary = ctx.execCalls.length;
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource, force: true }, ctx.deps);
		const forceCalls = ctx.execCalls.slice(boundary);
		expect(forceCalls).toContainEqual({
			file: "chflags",
			args: ["nouchg", join(ctx.cliDir, "claude")],
		});
		expect(forceCalls).toContainEqual({
			file: "chflags",
			args: ["nouchg", join(ctx.cliDir, "claude.real")],
		});
		const unlockAt = forceCalls.findIndex(isUnlockAny);
		const reCodesignAt = forceCalls.findIndex(isCodesign);
		expect(unlockAt).toBeGreaterThanOrEqual(0);
		expect(unlockAt).toBeLessThan(reCodesignAt);
	});

	it("uninstall clears `uchg` on both before restoring the real binary", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const boundary = ctx.execCalls.length;
		await uninstall(ctx.cliDir, {}, ctx.deps);
		const unCalls = ctx.execCalls.slice(boundary);
		expect(unCalls).toContainEqual({
			file: "chflags",
			args: ["nouchg", join(ctx.cliDir, "claude")],
		});
		expect(unCalls).toContainEqual({
			file: "chflags",
			args: ["nouchg", join(ctx.cliDir, "claude.real")],
		});
	});
});

describe("uninstall", () => {
	it("with flag unset → skipped no-op", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const disabled = { ...ctx.deps, env: {} };
		const result = await uninstall(ctx.cliDir, {}, disabled);
		expect(result).toStrictEqual({
			skipped: true,
			reason: expect.stringMatching(/CLAUDE_MULTIACCT_ENABLE_SHIM/u),
		});
	});

	it("restores claude.real → claude and snapshots first (reversibility contract)", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource }, ctx.deps);
		const result = await uninstall(ctx.cliDir, {}, ctx.deps);
		expect(result).toMatchObject({ skipped: false, uninstalled: true, wasInstalled: true });
		const claudeContent = await readFile(join(ctx.cliDir, "claude"), "utf8");
		expect(claudeContent).toContain("real-claude");
		const ok = result as Extract<typeof result, { skipped: false }>;
		expect(ok.backup).toBeDefined();
		const backupFiles = await readdir(ok.backup as string);
		// snapshot contains both the shim (as claude) and the stock (as claude.real)
		expect(backupFiles.toSorted()).toStrictEqual(["claude", "claude.real"]);
	});

	it("uninstall from a half-installed dir (only claude.real present, no shim) → still restores", async () => {
		// Models a mid-install crash: claude.real exists but claude was never
		// swapped in. Uninstall must still lift .real back to `claude`.
		const ctx = await makeCtx(true);
		const { rename: fsRename } = await import("node:fs/promises");
		await fsRename(join(ctx.cliDir, "claude"), join(ctx.cliDir, "claude.real"));
		// Nothing at `claude` now; uninstall should still succeed.
		const result = await uninstall(ctx.cliDir, {}, ctx.deps);
		expect(result).toMatchObject({ skipped: false, wasInstalled: true });
		const restored = await readFile(join(ctx.cliDir, "claude"), "utf8");
		expect(restored).toContain("real-claude");
	});

	it("uninstall on a clean dir → wasInstalled=false, no snapshot", async () => {
		const ctx = await makeCtx(true);
		const result = await uninstall(ctx.cliDir, { overrideFlag: true }, ctx.deps);
		expect(result).toMatchObject({ skipped: false, wasInstalled: false, backup: undefined });
	});
});

describe("install — default shim source (bundled dist/shim.js resolution)", () => {
	// Intent: PR2's ship-ready contract is that a caller doesn't have to know
	// where the built shim lives — the installer resolves to
	// packages/products/claude-multiacct/dist/shim.js on its own. These two tests
	// pin BOTH branches of that default: present → succeed, absent → loud throw.
	// Adversarial: if the "absent → throw" branch is silently downgraded to a
	// no-op, the second test flips red immediately.
	const bundledPath = defaultShimSourcePath();

	async function withDefaultAbsent<T>(fn: () => Promise<T>): Promise<T> {
		let saved: Buffer | undefined;
		const present = await stat(bundledPath)
			.then(() => true)
			.catch(() => false);
		if (present) {
			saved = await readFile(bundledPath);
			await unlink(bundledPath);
		}
		try {
			return await fn();
		} finally {
			if (saved === undefined) {
				// nothing to restore — original state was "missing"
			} else {
				await mkdir(dirname(bundledPath), { recursive: true });
				await writeFile(bundledPath, saved);
				await chmod(bundledPath, 0o755);
			}
		}
	}

	async function withDefaultStub<T>(stub: string, fn: () => Promise<T>): Promise<T> {
		let saved: Buffer | undefined;
		const present = await stat(bundledPath)
			.then(() => true)
			.catch(() => false);
		if (present) {
			saved = await readFile(bundledPath);
		}
		await mkdir(dirname(bundledPath), { recursive: true });
		await writeFile(bundledPath, stub, "utf8");
		try {
			return await fn();
		} finally {
			if (saved === undefined) {
				await unlink(bundledPath).catch(() => {});
			} else {
				await writeFile(bundledPath, saved);
			}
		}
	}

	it("resolves to packages/products/claude-multiacct/dist/shim.js", () => {
		expect(bundledPath).toMatch(/packages\/products\/claude-multiacct\/dist\/shim\.js$/u);
	});

	// Adversarial pin against Bug 1: the ORIGINAL code used
	// `new URL("../../dist/shim.js", import.meta.url)`. From the bundled
	// `dist/cma.js` context that resolved to `packages/products/dist/shim.js`
	// (one level too high), so every real install would fail with "shim not
	// found" — silently unless the operator was watching the log.
	//
	// The fix is a resolver that treats the shim as a SIBLING of the entry
	// when the entry lives in a dir named `dist/`, and only falls back to
	// the up-two-levels form when the caller is in src. These two cases pin
	// the sibling-in-dist behavior; if the fix is reverted to the old form,
	// the "dist context" case flips red (it would resolve to /pkg/dist/shim.js
	// with the OLD form starting from /pkg/dist/cma.js — wait, actually the
	// old form from /pkg/dist/cma.js would go up two to / and give
	// /dist/shim.js — either way NOT the expected /pkg/dist/shim.js sibling).
	it("resolveShimSourcePathFrom: from a bundled dist/cma.js URL → sibling dist/shim.js (Bug 1 adversarial: revert to '../../dist/shim.js' → red)", () => {
		const resolved = resolveShimSourcePathFrom("file:///opt/pkg/dist/cma.js");
		expect(resolved).toBe("/opt/pkg/dist/shim.js");
	});

	it("resolveShimSourcePathFrom: from a src/cli-shim/installer.ts URL → up-two-levels dist/shim.js (dev/test context)", () => {
		const resolved = resolveShimSourcePathFrom("file:///opt/pkg/src/cli-shim/installer.ts");
		expect(resolved).toBe("/opt/pkg/dist/shim.js");
	});

	it("install with NO shimSourcePath and default file present → copies the bundled shim", async () => {
		const ctx = await makeCtx(true);
		await withDefaultStub("#!/usr/bin/env node\nconsole.log('bundled-stub')\n", async () => {
			const result = await install(ctx.cliDir, {}, ctx.deps);
			expect(result).toMatchObject({ skipped: false, installed: true, alreadyInstalled: false });
			const claudeContent = await readFile(join(ctx.cliDir, "claude"), "utf8");
			expect(claudeContent).toContain("bundled-stub");
		});
	});

	it("install with NO shimSourcePath and default file MISSING → throws 'run pnpm build:shim first' (adversarial: silent no-op mutation makes this go red)", async () => {
		const ctx = await makeCtx(true);
		await withDefaultAbsent(async () => {
			await expect(install(ctx.cliDir, {}, ctx.deps)).rejects.toThrow(
				/packaged shim not found.*run `pnpm build:shim` first/u,
			);
			// Also assert we did NOT partially mutate cliDir — the throw must be pre-swap.
			const files = await readdir(ctx.cliDir);
			expect(files.toSorted()).toStrictEqual([".verified-1.2.3", "claude"].toSorted());
		});
	});
});

describe("install / uninstall — CLI-authoritative {flag} param (PR6b contract)", () => {
	// Intent: PR6b's `cma install` needs to pass its own truth value
	// (isEnabled({env, config})) so config.enabled=true works without
	// requiring the env var in the caller's shell. Adversarial: drop
	// the flag branch and either of these tests goes red — flag:true
	// would fall through to env (which is empty) and skip, and flag:false
	// with the env ON would proceed instead of skipping.
	it("install with {flag: true} runs even with the env var UNSET", async () => {
		const ctx = await makeCtx(false); // env is empty
		const result = await install(
			ctx.cliDir,
			{ shimSourcePath: ctx.shimSource, flag: true },
			ctx.deps,
		);
		expect(result).toMatchObject({ skipped: false, installed: true });
	});
	it("install with {flag: false} SKIPS even with the env var SET", async () => {
		const ctx = await makeCtx(true); // env has FLAG=1
		const before = await readdir(ctx.cliDir);
		const result = await install(
			ctx.cliDir,
			{ shimSourcePath: ctx.shimSource, flag: false },
			ctx.deps,
		);
		expect(result).toMatchObject({ skipped: true });
		expect(await readdir(ctx.cliDir)).toStrictEqual(before);
	});
	it("uninstall with {flag: true} runs even with env UNSET; {flag:false} skips with env SET", async () => {
		const ctx = await makeCtx(true);
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource, overrideFlag: true }, ctx.deps);
		const envOff = { ...ctx.deps, env: {} };
		const ok = await uninstall(ctx.cliDir, { flag: true }, envOff);
		expect(ok).toMatchObject({ skipped: false, uninstalled: true });
		// re-install then try flag:false to prove precedence
		await install(ctx.cliDir, { shimSourcePath: ctx.shimSource, overrideFlag: true }, ctx.deps);
		const skipped = await uninstall(ctx.cliDir, { flag: false }, ctx.deps);
		expect(skipped).toMatchObject({ skipped: true });
	});
});

describe("install / uninstall — default arg paths (flag-off is safe to exercise)", () => {
	// Rule 12: without deps, the flag defaults to process.env — which in CI is
	// unset, so the mutating ops short-circuit into {skipped:true}. Calling with
	// zero deps exercises the `deps.env ?? process.env` and `deps.logger ??
	// silentLogger` fallbacks WITHOUT writing anything.
	it("install with no deps → falls back to process.env + silent logger, still skipped", async () => {
		const ctx = await makeCtx(false);
		const before = await readdir(ctx.cliDir);
		const result = await install(ctx.cliDir, { shimSourcePath: ctx.shimSource });
		expect(result).toMatchObject({ skipped: true });
		expect(await readdir(ctx.cliDir)).toStrictEqual(before);
	});

	it("uninstall with no deps → same fallback path, still skipped", async () => {
		const ctx = await makeCtx(false);
		const before = await readdir(ctx.cliDir);
		const result = await uninstall(ctx.cliDir);
		expect(result).toMatchObject({ skipped: true });
		expect(await readdir(ctx.cliDir)).toStrictEqual(before);
	});
});
