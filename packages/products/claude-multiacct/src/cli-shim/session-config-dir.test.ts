/**
 * Intent: the per-session config dir is what makes a swapped session report the
 * SWAPPED account while its transcript stays in the shared tree. Each test pins
 * one load-bearing property of that design:
 *
 *   - native reads the shared config directly, so it must produce no dir and no
 *     writes (a dir here would fork the primary account's own transcript);
 *   - the identity file overrides ONLY `oauthAccount` and preserves every other
 *     shared field (dropping them would change unrelated CLI behaviour);
 *   - the stores are symlinks to the shared `~/.claude/<sub>` (a copy would fork
 *     the transcript — the whole bug this replaces);
 *   - re-running is idempotent and never rewrites a correct link (so a resume
 *     mid-session cannot thrash the transcript symlink);
 *   - a corrupt/missing shared config still yields a usable identity (the token
 *     is load-bearing; identity is best-effort);
 *   - a store whose shared target is absent is skipped, never faked.
 */

import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, AccountUuid, ClaudeAccountUuid } from "../domain/account.ts";
import {
	buildSessionConfigDir,
	realSessionConfigDeps,
	type SessionConfigDirDeps,
} from "./session-config-dir.ts";

const ACCOUNT_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as AccountUuid;
const CLAUDE_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as ClaudeAccountUuid;

function explicitAccount(overrides: Partial<Account> = {}): Account {
	return {
		uuid: ACCOUNT_UUID,
		label: "Work",
		subscriptionType: "claude_max",
		rateLimitTier: "tier-3",
		encryptedTokenRef: "handle",
		accountUuid: CLAUDE_UUID,
		identity: { email: "work@example.com" },
		source: "explicit",
		...overrides,
	};
}

const tempRoots: string[] = [];

type Harness = {
	deps: SessionConfigDirDeps;
	rootDir: string;
	sharedClaudeDir: string;
	sharedConfigPath: string;
	warn: ReturnType<typeof vi.fn>;
	symlinkCalls: () => number;
};

/**
 * Real filesystem on a throwaway temp dir (so symlink semantics are genuine),
 * with `symlink` and `rm` wrapped in spies for the idempotency assertions.
 *
 * @returns {Promise<Harness>} Deps pointed at the temp dir plus its path handles.
 */
async function harness(): Promise<Harness> {
	const base = await mkdtemp(join(tmpdir(), "cma-scd-"));
	tempRoots.push(base);
	const rootDir = join(base, "root");
	const sharedClaudeDir = join(base, "claude");
	const sharedConfigPath = join(base, "claude.json");
	const warn = vi.fn<(message: string) => void>();
	const symlinkSpy = vi.fn<typeof symlink>(symlink);
	const real = realSessionConfigDeps();
	const deps: SessionConfigDirDeps = {
		rootDir,
		sharedClaudeDir,
		sharedConfigPath,
		warn,
		fs: { ...real.fs, symlink: symlinkSpy },
	};
	return {
		deps,
		rootDir,
		sharedClaudeDir,
		sharedConfigPath,
		warn,
		symlinkCalls: () => symlinkSpy.mock.calls.length,
	};
}

const STORES = ["projects", "sessions", "todos", "shell-snapshots", "statsig", "session-env"];

async function seedSharedStores(sharedClaudeDir: string): Promise<void> {
	for (const sub of STORES) {
		await mkdir(join(sharedClaudeDir, sub), { recursive: true });
	}
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop();
		if (dir !== undefined) {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

describe("buildSessionConfigDir — native account", () => {
	it("returns undefined and writes nothing (native reads the shared config directly)", async () => {
		const h = await harness();
		const account = explicitAccount({ source: "native" });
		const result = await buildSessionConfigDir(account, h.deps);
		expect(result).toBeUndefined();
		// No account-config tree was created.
		await expect(lstat(join(h.rootDir, "account-config"))).rejects.toThrow(/ENOENT/u);
		expect(h.symlinkCalls()).toBe(0);
	});
});

describe("buildSessionConfigDir — explicit account identity view", () => {
	it("overrides only oauthAccount and preserves every other shared field", async () => {
		const h = await harness();
		await seedSharedStores(h.sharedClaudeDir);
		await writeFile(
			h.sharedConfigPath,
			JSON.stringify({
				numStartups: 12,
				oauthAccount: { accountUuid: "primary-uuid", emailAddress: "primary@x.com", extra: 1 },
				theme: "dark",
			}),
		);

		const dir = await buildSessionConfigDir(explicitAccount(), h.deps);
		expect(dir).toBe(join(h.rootDir, "account-config", ACCOUNT_UUID));

		const written = JSON.parse(await readFile(join(dir as string, ".claude.json"), "utf8")) as {
			numStartups: number;
			theme: string;
			oauthAccount: Record<string, unknown>;
		};
		// Unrelated shared fields survive untouched.
		expect(written.numStartups).toBe(12);
		expect(written.theme).toBe("dark");
		// oauthAccount is overridden to THIS account, merged over the shared one.
		expect(written.oauthAccount.accountUuid).toBe(CLAUDE_UUID);
		expect(written.oauthAccount.emailAddress).toBe("work@example.com");
		// A pre-existing sub-field the account does not set is preserved by the merge.
		expect(written.oauthAccount.extra).toBe(1);
	});

	it("symlinks every shared store back to ~/.claude/<sub>", async () => {
		const h = await harness();
		await seedSharedStores(h.sharedClaudeDir);
		await writeFile(h.sharedConfigPath, JSON.stringify({ oauthAccount: {} }));

		const dir = (await buildSessionConfigDir(explicitAccount(), h.deps)) as string;

		for (const sub of STORES) {
			const linkPath = join(dir, sub);
			const linkStat = await lstat(linkPath);
			expect(linkStat.isSymbolicLink()).toBe(true);
			expect(await readlink(linkPath)).toBe(join(h.sharedClaudeDir, sub));
		}
		expect(h.symlinkCalls()).toBe(STORES.length);
	});

	it("does not write accountUuid/emailAddress when the account lacks them", async () => {
		const h = await harness();
		await writeFile(h.sharedConfigPath, JSON.stringify({ oauthAccount: {} }));
		const account = explicitAccount({ accountUuid: undefined, identity: undefined });

		const dir = (await buildSessionConfigDir(account, h.deps)) as string;
		const written = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")) as {
			oauthAccount: Record<string, unknown>;
		};
		expect(written.oauthAccount).not.toHaveProperty("accountUuid");
		expect(written.oauthAccount).not.toHaveProperty("emailAddress");
	});
});

describe("buildSessionConfigDir — idempotent re-run", () => {
	it("leaves a correct link untouched and does not error on a second run", async () => {
		const h = await harness();
		await seedSharedStores(h.sharedClaudeDir);
		await writeFile(h.sharedConfigPath, JSON.stringify({ oauthAccount: {} }));

		await buildSessionConfigDir(explicitAccount(), h.deps);
		const afterFirst = h.symlinkCalls();
		expect(afterFirst).toBe(STORES.length);

		const dir = (await buildSessionConfigDir(explicitAccount(), h.deps)) as string;
		// Second run created zero new links — every store was already correct.
		expect(h.symlinkCalls()).toBe(afterFirst);
		// Links still resolve correctly.
		expect(await readlink(join(dir, "projects"))).toBe(join(h.sharedClaudeDir, "projects"));
	});

	it("repairs a wrong entry in place", async () => {
		const h = await harness();
		await seedSharedStores(h.sharedClaudeDir);
		await writeFile(h.sharedConfigPath, JSON.stringify({ oauthAccount: {} }));

		const dir = join(h.rootDir, "account-config", ACCOUNT_UUID);
		await mkdir(dir, { recursive: true });
		// A stale symlink pointing at the wrong place.
		await symlink(join(h.sharedClaudeDir, "sessions"), join(dir, "projects"));

		await buildSessionConfigDir(explicitAccount(), h.deps);
		expect(await readlink(join(dir, "projects"))).toBe(join(h.sharedClaudeDir, "projects"));
	});
});

describe("buildSessionConfigDir — fail-soft", () => {
	it("falls back to a minimal identity when the shared config is missing", async () => {
		const h = await harness();
		await seedSharedStores(h.sharedClaudeDir);
		// No shared config file written.

		const dir = (await buildSessionConfigDir(explicitAccount(), h.deps)) as string;
		const written = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")) as {
			oauthAccount: Record<string, unknown>;
		};
		expect(written.oauthAccount.accountUuid).toBe(CLAUDE_UUID);
		expect(written.oauthAccount.emailAddress).toBe("work@example.com");
		expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
	});

	it("falls back to a minimal identity when the shared config is corrupt JSON", async () => {
		const h = await harness();
		await writeFile(h.sharedConfigPath, "{ not json ");

		const dir = (await buildSessionConfigDir(explicitAccount(), h.deps)) as string;
		const written = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")) as {
			oauthAccount: Record<string, unknown>;
		};
		expect(written.oauthAccount.accountUuid).toBe(CLAUDE_UUID);
		expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
	});

	it("skips a store whose shared target does not exist", async () => {
		const h = await harness();
		// Only some stores exist in the shared dir.
		await mkdir(join(h.sharedClaudeDir, "projects"), { recursive: true });
		await writeFile(h.sharedConfigPath, JSON.stringify({ oauthAccount: {} }));

		const dir = (await buildSessionConfigDir(explicitAccount(), h.deps)) as string;
		// projects linked; sessions (absent target) skipped.
		const projectsStat = await lstat(join(dir, "projects"));
		expect(projectsStat.isSymbolicLink()).toBe(true);
		await expect(lstat(join(dir, "sessions"))).rejects.toThrow(/ENOENT/u);
		expect(h.symlinkCalls()).toBe(1);
	});
});

describe("realSessionConfigDeps", () => {
	it("binds real fs helpers and home-derived paths", () => {
		const deps = realSessionConfigDeps();
		expect(typeof deps.fs.symlink).toBe("function");
		expect(deps.sharedConfigPath.endsWith(".claude.json")).toBe(true);
		expect(deps.sharedClaudeDir.endsWith(".claude")).toBe(true);
		// warn is a real sink; exercising it must not throw.
		expect(() => {
			deps.warn("probe");
		}).not.toThrow();
	});
});
