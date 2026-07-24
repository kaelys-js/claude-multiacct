/**
 * `@foundation/claude-multiacct` — CLI-shim runtime orchestration.
 *
 * The desktop launcher `posix_spawn`s `.../Contents/MacOS/claude` with a
 * per-account OAuth token in `CLAUDE_CODE_OAUTH_TOKEN` and the session id in
 * `--session-id=<uuid>` (new sessions) or `--resume=<uuid>` (resumed ones).
 * When our shim binary sits at that path (installed by `./installer.ts`), it
 * runs first and gets a chance to swap the token before re-execing the REAL
 * Claude CLI (which the installer renamed to `claude.real` in the same
 * directory).
 *
 * The pipeline for one invocation:
 *
 *   1. Parse the session uuid out of argv (`env.parseSessionUuid`, which reads
 *      `--session-id`, `--resume`, and `-r`).
 *   2. Load the choice sidecar for that session uuid (`ChoiceStore.read`).
 *   3. Resolve the pinned account from the registry (`readRegistry` +
 *      `byUuid`). Missing/stale/absent → skip the swap.
 *   4. Fetch the account's opaque token handle (`TokenStore.get`).
 *   5. Prepare a per-account `CLAUDE_CONFIG_DIR` (`prepareConfigDir`) so the
 *      swapped session reports the swapped account's identity, not the
 *      launcher's default one.
 *   6. Build a swapped env (`env.applyTokenSwap`) and `spawnSync(claude.real,
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
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Account, AccountUuid } from "../domain/account.ts";
import { type AccountRegistry, byUuid } from "../domain/registry.ts";
import { applyTokenSwap, isInteractiveSession, parseSessionUuid } from "./env.ts";
import type { ChoiceStore, TokenStore } from "../ports.ts";
// session-pid helpers (writeSessionPid/removeSessionPid) and the config-dir
// prep are bound at the entry-point (the `scripts/build-shim.mjs` glue) and
// injected via `ShimDeps`; nothing here touches the real filesystem directly.

/**
 * Injected orchestration surface. Real deps are wired by the bundled entry the
 * `scripts/build-shim.mjs` glue emits into `dist/shim.js`; tests pass fakes to
 * drive every branch (choice-present, choice-absent, stale choice, corrupted
 * store, token failure).
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
	/**
	 * Audit hook fired on every child spawn (both the initial spawn and each
	 * SIGHUP-driven respawn on the hot-swap path). `tokenHash` is a short
	 * digest of the token that will be handed to `claude.real` — the raw
	 * token is never surfaced here. Runtime binds this to an append-only
	 * log file under `~/.claude-multiacct/logs/`. Optional; when absent the
	 * spawn proceeds silently.
	 */
	logSpawn?: (sessionUuid: string | undefined, tokenHash: string) => void;
	/**
	 * Build the per-session identity view of the config dir for the resolved
	 * account and return its absolute path, or `undefined` to leave
	 * `CLAUDE_CONFIG_DIR` unset (the native/primary account reads the shared
	 * config directly). Bound at the entry-point to `buildSessionConfigDir`,
	 * which copies the shared `~/.claude.json` with `oauthAccount` overridden to
	 * this account and symlinks the transcript/session stores back to the shared
	 * `~/.claude`, so the swapped session self-reports the swapped account while
	 * its transcript stays in the one shared tree. Tests inject a fake. When the
	 * dep is absent, the swap sets no `CLAUDE_CONFIG_DIR` and the child reads the
	 * default config (legacy token-only behaviour).
	 */
	prepareConfigDir?: (account: Account) => Promise<string | undefined>;
	/**
	 * Mint a fresh session uuid. Called ONLY for the app's real interactive
	 * session (`env.isInteractiveSession`) when the launcher passed no
	 * `--session-id`/`--resume` in argv — the fresh-session case where the CLI
	 * would otherwise generate its own uuid the shim never learns. When present,
	 * the shim mints the id, injects `--session-id=<uuid>` into the FIRST child
	 * spawn (so `claude.real` adopts it and writes its transcript under it) and
	 * `--resume=<uuid>` into every SIGHUP respawn (so the transcript continues,
	 * no fork). This is what makes a brand-new app session both targetable (a pid
	 * file keyed on a real uuid) and hot-swappable. Runtime binds
	 * `crypto.randomUUID`; tests inject a deterministic generator. Absent → fresh
	 * interactive sessions are not registered (pre-fix behaviour).
	 */
	newSessionUuid?: () => string;
	/**
	 * The launcher's stdin stream, forwarded to each spawned child on the
	 * hot-swap path. **Load-bearing for the persistent-process case.** The app
	 * drives a Code session as ONE long-lived `stream-json` process fed over
	 * stdin; a SIGHUP hot-swap kills that child and respawns it. If the child
	 * inherited the shim's stdin directly (`stdio:"inherit"`), the RESPAWNED
	 * `claude.real` does not pick up subsequent stdin turns — proven on the mini:
	 * the swap + transcript continuity succeed but the next turn never reaches the
	 * new child, so it emits nothing. Giving each child its OWN stdin pipe and
	 * forwarding this stream into the current child (exactly like a fresh
	 * `--resume` spawn, which works) closes that gap. When present, the hot-swap
	 * path spawns children with piped std streams and relays them; when absent, it
	 * keeps the legacy `stdio:"inherit"` (all existing tests + the single-shot
	 * paths are unaffected). Runtime binds `process.stdin`; tests inject a fake.
	 */
	stdin?: NodeJS.ReadableStream;
	/**
	 * The launcher's stdout, that the hot-swap path relays each child's stdout
	 * into. **Load-bearing alongside `stdin`.** If a child inherited stdout
	 * directly, the FIRST child's libuv leaves `O_NONBLOCK` on the shared pipe;
	 * the RESPAWNED child then inherits that flag and its stream-json output never
	 * reaches the app (proven on the mini: swap + transcript succeed but the new
	 * child emits nothing). Giving each child its OWN stdout pipe and relaying it
	 * — exactly like a fresh spawn, which works — fixes it. Bound to
	 * `process.stdout` at runtime; only used when `stdin` is also present.
	 */
	stdout?: NodeJS.WritableStream;
	/** The launcher's stderr, relayed per child for the same reason as `stdout`. Bound to `process.stderr`. */
	stderr?: NodeJS.WritableStream;
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

	// Resolve the session identity ONCE: the launcher-supplied id for a resumed
	// session, else a freshly minted id for the app's real interactive session
	// (the fresh-session case the launcher leaves id-less in argv). Everything
	// downstream — the choice lookup, the pid-file key, the injected
	// `--session-id`/`--resume` — keys on this single resolved uuid.
	const { sessionUuid, minted } = resolveSessionIdentity(deps);

	const swappedEnv = (await computeSwappedEnv(deps, sessionUuid).catch((error: unknown) => {
		deps.warn(`cma-shim: swap path failed (${describe(error)}); passing through to primary`);
	})) as Record<string, string> | undefined;

	const envForChild = swappedEnv ?? deps.env;

	// Hot-swap path: only when we have a session uuid + all injected
	// pieces (spawn + onSighup + writePidFile + removePidFile). Absence of
	// ANY piece falls back to the classic spawnSync path — that's how the
	// tests + prior behavior stay intact.
	const canHotSwap =
		sessionUuid !== undefined &&
		deps.spawn !== undefined &&
		deps.onSighup !== undefined &&
		deps.writePidFile !== undefined &&
		deps.removePidFile !== undefined;

	if (canHotSwap && sessionUuid !== undefined) {
		return await runShimHotSwappable(
			deps,
			realBin,
			forwardedArgs,
			envForChild,
			sessionUuid,
			minted,
			swappedEnv !== undefined,
		);
	}

	// Classic single-shot path. A minted-but-not-hot-swappable session (deps
	// missing the spawn/signal wiring) still injects `--session-id` so the
	// child adopts our id; a non-minted session forwards argv unchanged.
	const initialArgs = buildChildArgs(forwardedArgs, sessionUuid, minted, "initial");
	fireLogSpawn(deps, sessionUuid, envForChild);
	const spawnResult = deps.spawnSync(realBin, initialArgs, {
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
 * Decide the session uuid this invocation runs under, and whether we minted it.
 *
 * A resumed session carries its id in argv (`--session-id`/`--resume`); parse
 * it. A brand-new interactive session does NOT — the launcher spawns it id-less
 * and lets the CLI generate one internally, which the shim would never learn,
 * so it could neither register a pid file nor read a choice keyed on it. For
 * that case (and only that case: `isInteractiveSession` excludes the app's
 * short-lived probe spawns) we mint an id and adopt it via `--session-id`.
 *
 * @param {ShimDeps} deps - Injected orchestration surface.
 * @returns {{ sessionUuid: string | undefined; minted: boolean }} Resolved id + origin.
 */
function resolveSessionIdentity(deps: ShimDeps): {
	sessionUuid: string | undefined;
	minted: boolean;
} {
	const parsed = parseSessionUuid(deps.argv);
	if (parsed !== undefined) {
		return { sessionUuid: parsed, minted: false };
	}
	if (deps.newSessionUuid !== undefined && isInteractiveSession(deps.argv)) {
		return { sessionUuid: deps.newSessionUuid(), minted: true };
	}
	return { sessionUuid: undefined, minted: false };
}

/**
 * Build the argv handed to `claude.real`. For a minted fresh session the first
 * spawn adds `--session-id=<uuid>` (the CLI creates the session under our id),
 * and every SIGHUP respawn adds `--resume=<uuid>` (the CLI continues the SAME
 * transcript rather than forking a new one). Non-minted sessions forward argv
 * untouched — their id is already present in `forwardedArgs`.
 *
 * @param {readonly string[]} forwardedArgs - argv[2..] as received.
 * @param {string | undefined} sessionUuid - Resolved session uuid.
 * @param {boolean} minted - Whether the shim minted the id (vs parsed from argv).
 * @param {"initial" | "respawn"} phase - First spawn vs a hot-swap respawn.
 * @returns {string[]} The child argv.
 */
function buildChildArgs(
	forwardedArgs: readonly string[],
	sessionUuid: string | undefined,
	minted: boolean,
	phase: "initial" | "respawn",
): string[] {
	if (!minted || sessionUuid === undefined) {
		return [...forwardedArgs];
	}
	const flag = phase === "initial" ? "--session-id" : "--resume";
	return [...forwardedArgs, flag, sessionUuid];
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
 * @param {boolean} minted - Whether the shim minted the id (drives `--session-id`/`--resume` injection).
 * @param {boolean} initialSwapped - Whether the first env is a swap or pass-through.
 * @returns {Promise<ShimResult>} `{exitCode, swapped}` from the final child.
 */
async function runShimHotSwappable(
	deps: ShimDeps,
	realBin: string,
	forwardedArgs: readonly string[],
	initialEnv: Record<string, string>,
	sessionUuid: string,
	minted: boolean,
	initialSwapped: boolean,
): Promise<ShimResult> {
	// Non-null after the canHotSwap check.
	const spawn = deps.spawn as NonNullable<ShimDeps["spawn"]>;
	const onSighup = deps.onSighup as NonNullable<ShimDeps["onSighup"]>;
	const writePidFile = deps.writePidFile as NonNullable<ShimDeps["writePidFile"]>;
	const removePidFile = deps.removePidFile as NonNullable<ShimDeps["removePidFile"]>;

	// First spawn adopts the id (`--session-id` when minted); respawns resume it.
	const initialArgs = buildChildArgs(forwardedArgs, sessionUuid, minted, "initial");
	const respawnArgs = buildChildArgs(forwardedArgs, sessionUuid, minted, "respawn");

	try {
		await writePidFile(sessionUuid);
	} catch (error) {
		deps.warn(
			`cma-shim: writePidFile failed (${describe(error)}); hot-swap disabled for this session`,
		);
		// Fall back to spawnSync single-shot path.
		fireLogSpawn(deps, sessionUuid, initialEnv);
		const spawnResult = deps.spawnSync(realBin, initialArgs, {
			stdio: "inherit",
			env: initialEnv,
		});
		if (spawnResult.error !== undefined) {
			deps.warn(`cma-shim: exec of ${realBin} failed: ${describe(spawnResult.error)}`);
			return { exitCode: 127, swapped: initialSwapped };
		}
		return { exitCode: spawnResult.status ?? 0, swapped: initialSwapped };
	}

	let currentEnv = initialEnv;
	let currentArgs = initialArgs;
	let currentSwapped = initialSwapped;
	let swapPending = false;

	// stdio proxy: when the launcher's streams are injected, the shim owns them
	// and gives each child its OWN pipes, relaying between them. This is what
	// makes a SIGHUP-respawned child usable: it receives subsequent stdin turns
	// AND its stdout reaches the app (a directly-inherited stdio pipe carries
	// libuv's `O_NONBLOCK` from the first child into the respawned one, silencing
	// it — proven on the mini). Stdin bytes that arrive between children are
	// buffered and flushed to the next; stdout/stderr are per-child and relayed
	// straight through. Absent → legacy `stdio:"inherit"` (single-shot paths and
	// every existing test are unaffected).
	const proxyStdio = deps.stdin !== undefined;
	const childStdio: childProcess.StdioOptions = proxyStdio ? ["pipe", "pipe", "pipe"] : "inherit";
	let currentStdin: NodeJS.WritableStream | undefined;
	let stdinEnded = false;
	const pendingStdin: Buffer[] = [];
	const onStdinData = (chunk: Buffer | string): void => {
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (currentStdin !== undefined && currentStdin.writable) {
			currentStdin.write(buf);
		} else {
			pendingStdin.push(buf);
		}
	};
	const onStdinEnd = (): void => {
		stdinEnded = true;
		currentStdin?.end();
	};
	if (proxyStdio) {
		const source = deps.stdin as NodeJS.ReadableStream;
		source.on("data", onStdinData);
		source.on("end", onStdinEnd);
		// Keep the launcher stdin in flowing mode; if it was paused (e.g. the
		// stream reverted after the first child's pipe was torn down on the
		// respawn) a later turn would never be emitted to `onStdinData`.
		source.resume?.();
	}
	// Wire a freshly-spawned child's std streams to the proxy: point stdin at it
	// (flushing anything buffered during the respawn gap, honouring a prior EOF),
	// and relay its stdout/stderr into the launcher's streams.
	const attachChildStdio = (child: childProcess.ChildProcess): void => {
		if (!proxyStdio) {
			return;
		}
		const sink = child.stdin ?? undefined;
		currentStdin = sink ?? undefined;
		if (sink !== undefined) {
			// A dying child's stdin can EPIPE; swallow it — never crash the shim.
			sink.on("error", () => {
				// ignore
			});
			for (const buf of pendingStdin.splice(0)) {
				sink.write(buf);
			}
			if (stdinEnded) {
				sink.end();
			}
		}
		const out = deps.stdout;
		if (out !== undefined && child.stdout !== null && child.stdout !== undefined) {
			child.stdout.on("data", (chunk: Buffer) => {
				out.write(chunk);
			});
		}
		const errOut = deps.stderr;
		if (errOut !== undefined && child.stderr !== null && child.stderr !== undefined) {
			child.stderr.on("data", (chunk: Buffer) => {
				errOut.write(chunk);
			});
		}
		// Re-assert flowing mode: piping a fresh child in can leave the launcher
		// stdin paused, which would strand the next turn.
		deps.stdin?.resume?.();
	};

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
		fireLogSpawn(deps, sessionUuid, currentEnv);
		const child = spawn(realBin, currentArgs, {
			stdio: childStdio,
			env: currentEnv,
		});
		currentChild = child;
		attachChildStdio(child);
		// eslint-disable-next-line no-await-in-loop, no-loop-func -- Serial by design; child is captured immutably per iteration.
		const exitCode = await waitForChildExit(child, realBin, deps);
		// Detach the proxy from the dead child; further stdin buffers until the
		// next child (or is dropped if the loop breaks).
		currentStdin = undefined;
		lastExitCode = exitCode;

		if (!swapPending) {
			break;
		}

		// Recompute the swap. If it now fails, pass through with the
		// original env (matches the fallback contract at the top level).
		// eslint-disable-next-line no-await-in-loop -- Serial by design.
		const nextEnv = (await computeSwappedEnv(deps, sessionUuid).catch((error: unknown) => {
			deps.warn(`cma-shim: swap-on-SIGHUP recompute failed (${describe(error)}); passing through`);
		})) as Record<string, string> | undefined;
		currentEnv = nextEnv ?? deps.env;
		currentSwapped = nextEnv !== undefined;
		// Every spawn after the first RESUMES the session id rather than
		// re-creating it, so the transcript stays one continuous file.
		currentArgs = respawnArgs;
	}

	offSighup();
	if (proxyStdio) {
		const source = deps.stdin as NodeJS.ReadableStream;
		source.off("data", onStdinData);
		source.off("end", onStdinEnd);
	}
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
 * @param {string | undefined} sessionUuid - The resolved session id (parsed from
 *   argv or minted for a fresh interactive session); `undefined` → pass through.
 * @returns {Promise<Record<string, string> | undefined>} Swapped env or fall-through signal.
 */
async function computeSwappedEnv(
	deps: ShimDeps,
	sessionUuid: string | undefined,
): Promise<Record<string, string> | undefined> {
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
	// Per-account config dir so the swapped session reports the swapped account's
	// identity. A failure here must not sink the swap: the token is the load-
	// bearing part, and losing config-dir isolation only degrades the reported
	// email, so warn and continue with the token-only swap.
	let configDir: string | undefined;
	if (deps.prepareConfigDir !== undefined) {
		try {
			configDir = await deps.prepareConfigDir(account);
		} catch (error) {
			deps.warn(
				`cma-shim: prepareConfigDir failed for ${account.uuid} (${describe(error)}); swapping token without a per-account config dir`,
			);
		}
	}
	return applyTokenSwap(deps.env, {
		oauthToken: token,
		subscriptionType: account.subscriptionType,
		rateLimitTier: account.rateLimitTier,
		configDir,
	});
}

/**
 * Fire the optional `logSpawn` audit hook. Any exception is swallowed —
 * logging must never block a spawn or crash the shim. The token digest
 * is the first 16 hex chars of sha256 over the OAuth token, matching the
 * runtime log format; an empty token hashes to a stable empty-string
 * digest so pass-through spawns are still distinguishable in the log.
 *
 * @param {ShimDeps} deps - Injected orchestration surface.
 * @param {string | undefined} sessionUuid - Session uuid parsed from argv.
 * @param {Record<string, string>} envForChild - Env that will be passed to `claude.real`.
 */
function fireLogSpawn(
	deps: ShimDeps,
	sessionUuid: string | undefined,
	envForChild: Record<string, string>,
): void {
	if (deps.logSpawn === undefined) {
		return;
	}
	try {
		const token = envForChild.CLAUDE_CODE_OAUTH_TOKEN ?? "";
		const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16);
		deps.logSpawn(sessionUuid, tokenHash);
	} catch {
		// audit-only sink; never propagate
	}
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
