/**
 * `@foundation/claude-multiacct` — CLI-shim runtime orchestration.
 *
 * The desktop launcher `posix_spawn`s `.../Contents/MacOS/claude` with a
 * per-account OAuth token in `CLAUDE_CODE_OAUTH_TOKEN` and the session id in
 * `--resume=<uuid>`. When our shim binary sits at that path (installed by
 * `./installer.ts`), it runs first and gets a chance to swap the token
 * before re-execing the REAL Claude CLI (which the installer renamed to
 * `claude.real` in the same directory).
 *
 * The pipeline for one invocation:
 *
 *   1. Parse `--resume=<uuid>` out of argv (`env.parseResumeUuid`).
 *   2. Load the choice sidecar for that session uuid (`ChoiceStore.read`).
 *   3. Resolve the pinned account from the registry (`readRegistry` +
 *      `byUuid`). Missing/stale/absent → skip the swap.
 *   4. Fetch the account's opaque token handle (`TokenStore.get`).
 *   5. Build a swapped env (`env.applyTokenSwap`) and `spawnSync(claude.real,
 *      argv[2..], {env})`, forwarding the child's exit code.
 *
 * The load-bearing invariant: **every error path is pass-through**. Any
 * failure — no session uuid, no choice, stale choice, corrupted sidecar,
 * missing registry, token lookup failure, whatever — falls back to execing
 * `claude.real` with the ORIGINAL env. The user's primary account behavior
 * must never be worse for the shim being installed. All warnings go to
 * stderr; nothing is fatal to the desktop's Code session.
 *
 * The runtime deliberately uses `spawnSync + exit` rather than `execve`. A
 * true exec would preserve pid + libc identity, but Node has no `execve`
 * primitive; a native shim adds complexity + codesigning drift with no
 * observable benefit for our use case (the parent is `disclaimer`, not a
 * process manager watching pid). The trade-off: one extra Node process in
 * the tree during the CLI session, worth ~30 MB RSS. Documented so the
 * choice is auditable rather than an accident.
 *
 * @module
 */

import type * as childProcess from "node:child_process";
import { dirname, join } from "node:path";
import type { Account, AccountUuid } from "../domain/account.ts";
import { type AccountRegistry, byUuid } from "../domain/registry.ts";
import { applyTokenSwap, parseResumeUuid } from "./env.ts";
import type { ChoiceStore, TokenStore } from "../ports.ts";

/**
 * Injected orchestration surface. Real deps are wired in `./entry.ts`; tests
 * pass fakes to drive every branch (choice-present, choice-absent, stale
 * choice, corrupted store, token failure).
 */
export type ShimDeps = {
	argv: readonly string[];
	env: Record<string, string>;
	/** Directory containing this shim binary. `claude.real` sits next to it. */
	binDir: string;
	choiceStore: ChoiceStore;
	readRegistry: () => Promise<AccountRegistry | undefined>;
	tokenStore: TokenStore;
	/** `child_process.spawnSync`-shaped. Real impl inherits stdio. */
	spawnSync: (
		file: string,
		args: readonly string[],
		opts: childProcess.SpawnSyncOptions,
	) => { status: number | null; error?: Error };
	/** Warn sink; runtime binds stderr, tests inject a spy. */
	warn: (message: string) => void;
};

/** Result of one shim invocation. `swapped` tells the caller which path won. */
export type ShimResult = { exitCode: number; swapped: boolean };

/**
 * Run one shim invocation.
 *
 * Every failure falls through to a pass-through exec of `claude.real` with
 * the original env; the boolean `swapped` in the result tells the caller
 * (and the tests) which path won. The function never throws — it always
 * returns a result with an exit code.
 *
 * @param {ShimDeps} deps - Injected orchestration surface.
 * @returns {Promise<ShimResult>} `{exitCode, swapped}` — forward the code.
 */
export async function runShim(deps: ShimDeps): Promise<ShimResult> {
	const realBin = join(deps.binDir, "claude.real");
	const forwardedArgs = deps.argv.slice(2);

	const swappedEnv = (await computeSwappedEnv(deps).catch((error: unknown) => {
		deps.warn(`cma-shim: swap path failed (${describe(error)}); passing through to primary`);
	})) as Record<string, string> | undefined;

	const envForChild = swappedEnv ?? deps.env;
	const spawnResult = deps.spawnSync(realBin, forwardedArgs, {
		stdio: "inherit",
		env: envForChild,
	});
	if (spawnResult.error !== undefined) {
		deps.warn(`cma-shim: exec of ${realBin} failed: ${describe(spawnResult.error)}`);
		return { exitCode: 127, swapped: swappedEnv !== undefined };
	}
	return { exitCode: spawnResult.status ?? 0, swapped: swappedEnv !== undefined };
}

/**
 * Compute the swapped env, or `undefined` when we should pass through. Any
 * caught exception in this function is treated as pass-through by `runShim`
 * — that catch is the sole safety net the fallback contract relies on.
 *
 * @param {ShimDeps} deps - Injected orchestration surface.
 * @returns {Promise<Record<string, string> | undefined>} Swapped env or fall-through signal.
 */
async function computeSwappedEnv(deps: ShimDeps): Promise<Record<string, string> | undefined> {
	const sessionUuid = parseResumeUuid(deps.argv);
	if (sessionUuid === undefined) {
		return undefined;
	}

	const state = await deps.choiceStore.read();
	const choice = state[sessionUuid];
	if (choice === undefined) {
		return undefined;
	}

	const registry = await deps.readRegistry();
	if (registry === undefined) {
		return undefined;
	}

	const account: Account | undefined = byUuid(registry, choice.accountUuid);
	if (account === undefined) {
		deps.warn(`cma-shim: choice references unknown account ${choice.accountUuid}; passing through`);
		return undefined;
	}

	const token = await deps.tokenStore.get(account.uuid as AccountUuid);
	if (token === undefined) {
		// The port's `get` may return undefined for a soft-miss; the shim treats
		// that the same as a throw — pass through, warn.
		deps.warn(`cma-shim: token store returned undefined for ${account.uuid}; passing through`);
		return undefined;
	}
	return applyTokenSwap(deps.env, {
		oauthToken: token,
		subscriptionType: account.subscriptionType,
		rateLimitTier: account.rateLimitTier,
	});
}

/**
 * Compact error → string that never throws (guards against non-Error rejections).
 *
 * @param {unknown} err - Anything a Promise rejected with.
 * @returns {string} A short human-readable message.
 */
function describe(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

/**
 * Convenience: the directory containing `import.meta.url`. Used by the
 * entry file to compute `binDir` without hand-writing `dirname(fileURL)`.
 *
 * @param {string} moduleUrl - `import.meta.url` of the entry file.
 * @returns {string} Absolute directory of the module file.
 */
export function moduleDir(moduleUrl: string): string {
	const path = new URL(moduleUrl).pathname;
	return dirname(path);
}
