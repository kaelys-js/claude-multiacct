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
// session-pid helpers (writeSessionPid/removeSessionPid) are used at the
// entry-point in `entry.ts` to bind the injected ports; not imported here.

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
	/**
	 * `child_process.spawn`-shaped, async. Only used by the SIGHUP hot-swap
	 * path — the normal (no-signal) invocation still goes through `spawnSync`
	 * for zero behavioural drift from the pre-hot-swap runtime. When present
	 * AND `sessionUuid` resolves AND `writePidFile` succeeds, `runShim` uses
	 * the async path and registers a SIGHUP handler that kills the child +
	 * respawns with a freshly-computed swapped env.
	 */
	spawn?: (
		file: string,
		args: readonly string[],
		opts: childProcess.SpawnOptions,
	) => childProcess.ChildProcess;
	/** Warn sink; runtime binds stderr, tests inject a spy. */
	warn: (message: string) => void;
	/**
	 * Register a SIGHUP handler; return an off() that unregisters. Injected
	 * so tests exercise the swap path without touching the real signal
	 * table. Runtime binds `process.on("SIGHUP", h)` / `process.off(...)`.
	 */
	onSighup?: (handler: () => void) => () => void;
	/**
	 * Write the shim's PID as owner of this session, so the daemon's
	 * `POST /choice/:sessionUuid` handler can `signalSwap(sessionUuid)` to
	 * find us. Injected so tests never touch the real disk. Runtime binds
	 * `writeSessionPid` from `./session-pid.ts`.
	 */
	writePidFile?: (sessionUuid: string) => Promise<void>;
	/** Remove the PID file on graceful exit. Injected — runtime binds `removeSessionPid`. */
	removePidFile?: (sessionUuid: string) => Promise<void>;
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

	// Hot-swap path: only when we have a session uuid + all injected
	// pieces (spawn + onSighup + writePidFile + removePidFile). Absence of
	// ANY piece falls back to the classic spawnSync path — that's how the
	// tests + prior behavior stay intact.
	const sessionUuid = parseResumeUuid(deps.argv);
	const canHotSwap =
		sessionUuid !== undefined &&
		deps.spawn !== undefined &&
		deps.onSighup !== undefined &&
		deps.writePidFile !== undefined &&
		deps.removePidFile !== undefined;

	if (canHotSwap && sessionUuid !== undefined) {
		return await runShimHotSwappable(deps, realBin, forwardedArgs, envForChild, sessionUuid, swappedEnv !== undefined);
	}

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
 * Async spawn path with SIGHUP-driven kill+respawn. Registers a SIGHUP
 * handler that kills the current child (SIGTERM, 3s grace, then SIGKILL),
 * waits for it, then respawns `claude.real` with a freshly-computed
 * swapped env. Loops until a child exits without a pending swap signal.
 *
 * @param {ShimDeps} deps - Injected orchestration surface.
 * @param {string} realBin - Absolute path of `claude.real`.
 * @param {readonly string[]} forwardedArgs - argv[2..] to pass to the child.
 * @param {Record<string, string>} initialEnv - Env for the first child spawn.
 * @param {string} sessionUuid - Session uuid; PID file is keyed on this.
 * @param {boolean} initialSwapped - Whether the first env is a swap or pass-through.
 * @returns {Promise<ShimResult>} `{exitCode, swapped}` from the final child.
 */
async function runShimHotSwappable(
	deps: ShimDeps,
	realBin: string,
	forwardedArgs: readonly string[],
	initialEnv: Record<string, string>,
	sessionUuid: string,
	initialSwapped: boolean,
): Promise<ShimResult> {
	// Non-null after the canHotSwap check.
	const spawn = deps.spawn as NonNullable<ShimDeps["spawn"]>;
	const onSighup = deps.onSighup as NonNullable<ShimDeps["onSighup"]>;
	const writePidFile = deps.writePidFile as NonNullable<ShimDeps["writePidFile"]>;
	const removePidFile = deps.removePidFile as NonNullable<ShimDeps["removePidFile"]>;

	try {
		await writePidFile(sessionUuid);
	} catch (error) {
		deps.warn(`cma-shim: writePidFile failed (${describe(error)}); hot-swap disabled for this session`);
		// Fall back to spawnSync single-shot path.
		const spawnResult = deps.spawnSync(realBin, forwardedArgs, { stdio: "inherit", env: initialEnv });
		if (spawnResult.error !== undefined) {
			deps.warn(`cma-shim: exec of ${realBin} failed: ${describe(spawnResult.error)}`);
			return { exitCode: 127, swapped: initialSwapped };
		}
		return { exitCode: spawnResult.status ?? 0, swapped: initialSwapped };
	}

	let currentEnv = initialEnv;
	let currentSwapped = initialSwapped;
	let swapPending = false;

	// Register SIGHUP handler that sets a flag; the loop honours it after
	// the current child exits (or kills it early on a subsequent signal).
	let currentChild: childProcess.ChildProcess | undefined;
	const offSighup = onSighup(() => {
		swapPending = true;
		const child = currentChild;
		if (child !== undefined && child.exitCode === null && child.signalCode === null) {
			// SIGTERM the child; if it doesn't exit within 3s, SIGKILL.
			try {
				child.kill("SIGTERM");
			} catch {
				// child may have already exited between the check + kill; ignore
			}
			setTimeout(() => {
				const c = currentChild;
				if (c !== undefined && c.exitCode === null && c.signalCode === null) {
					try {
						c.kill("SIGKILL");
					} catch {
						// child already gone; ignore
					}
				}
			}, 3000).unref();
		}
	});

	let lastExitCode = 0;
	// Serial by design: each child must exit before the next spawn — otherwise
	// two live children would be racing over the same session's stdio.
	// eslint-disable-next-line no-constant-condition, no-await-in-loop -- Explicit break when no swap pending; serial by design.
	while (true) {
		swapPending = false;
		const child = spawn(realBin, forwardedArgs, {
			stdio: "inherit",
			env: currentEnv,
		});
		currentChild = child;
		// eslint-disable-next-line no-await-in-loop, no-loop-func -- Serial by design; child is captured immutably per iteration.
		const exitCode = await waitForChildExit(child, realBin, deps);
		lastExitCode = exitCode;

		if (!swapPending) {
			break;
		}

		// Recompute the swap. If it now fails, pass through with the
		// original env (matches the fallback contract at the top level).
		// eslint-disable-next-line no-await-in-loop -- Serial by design.
		const nextEnv = (await computeSwappedEnv(deps).catch((error: unknown) => {
			deps.warn(`cma-shim: swap-on-SIGHUP recompute failed (${describe(error)}); passing through`);
		})) as Record<string, string> | undefined;
		currentEnv = nextEnv ?? deps.env;
		currentSwapped = nextEnv !== undefined;
	}

	offSighup();
	try {
		await removePidFile(sessionUuid);
	} catch {
		// idempotent
	}
	return { exitCode: lastExitCode, swapped: currentSwapped };
}

/**
 * Wait for a spawned child to exit; resolves to the exit code (or 128+sig
 * for signal-death). Never rejects — pass-through errors resolve to 127.
 *
 * @param {childProcess.ChildProcess} child - Spawned child.
 * @param {string} realBin - Absolute path of the child binary (for error text).
 * @param {ShimDeps} deps - For the warn sink on spawn-error.
 * @returns {Promise<number>} Exit code.
 */
function waitForChildExit(
	child: childProcess.ChildProcess,
	realBin: string,
	deps: ShimDeps,
): Promise<number> {
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => {
			resolve(code ?? (signal === null ? 0 : 128 + signalNumber(signal)));
		});
		child.once("error", (error) => {
			deps.warn(`cma-shim: exec of ${realBin} failed: ${describe(error)}`);
			resolve(127);
		});
	});
}

function signalNumber(signal: NodeJS.Signals): number {
	// POSIX signal numbers we might encounter on macOS.
	const table: Record<string, number> = {
		SIGHUP: 1,
		SIGINT: 2,
		SIGQUIT: 3,
		SIGKILL: 9,
		SIGTERM: 15,
	};
	return table[signal] ?? 0;
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
