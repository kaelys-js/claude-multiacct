/**
 * `@foundation/claude-multiacct` — watcher runtime entry.
 *
 * `runWatcher` is the idempotent body of a single pass: it stitches
 * `scan → reconcile → install` over the claude-code siblings under
 * `~/Library/Application Support/Claude/claude-code/` and returns a summary the
 * caller may log. `watchResident` wraps it in a resident daemon loop that holds
 * one recursive `fs.watch` on that parent and fires a debounced pass on every
 * change, re-planting the shim sub-second instead of waiting for launchd to
 * cold-spawn a fresh agent after the session already started.
 *
 * A Claude auto-update is the exact event this agent reacts to: the updated app
 * drops a new `claude-code/<version>/` sibling (which fires `WatchPaths`) AND
 * ships a stock CLI with no `claude.real`. The same update can leave the
 * renderer picker's plant needing a heal too. So each fire re-applies BOTH
 * halves of the install: the per-version CLI shim (via `install`) and the
 * picker extension plant (via `ensureExtension`). The extension re-apply is a
 * single idempotent self-heal — `extension/installer.ts` re-plants the loader
 * cache and re-deletes the sibling `.crx` on every call — not a per-dir loop.
 *
 * Three behaviours are load-bearing:
 *
 *   - **Per-dir isolation** — one failing dir MUST NOT abort the others.
 *     The install loop uses a per-iteration try/catch and pushes failures into
 *     `summary.failed`. Adversarial: remove the try/catch and the "one dir
 *     fails, others still install" test in `watcher.test.ts` goes red.
 *   - **Flag routing lives in `reconcile`, not here** — this runtime just
 *     executes what reconcile plans, so the flag-off contract is verified by
 *     `reconcile.test.ts` and the watcher body stays trivial. The extension
 *     self-heal is gated on the same resolved `flag` so a flag-off run is a
 *     total no-op.
 *   - **Extension heal never aborts the run** — a throwing `ensureExtension` is
 *     caught and recorded in `summary.extension`, mirroring the per-dir shim
 *     isolation. The CLI shim work and the picker heal are independent failures.
 *
 * The launchd-facing entry (selftest gate + node-fs binding + process.env
 * lookup) lives inline in `scripts/build-watcher.mjs`, matching the pattern
 * `scripts/build-shim.mjs` uses to keep the bundled boot code out of vitest
 * src coverage.
 *
 * @module
 */

import { join } from "node:path";
import type { FsPort } from "./fs-port.ts";
import { reconcile } from "./reconcile.ts";
import { scanClaudeCodeDirs } from "./scan.ts";

/** Callable install surface. Real impl: PR2's `installer.install`. Tests: mock. */
export type WatcherInstallFn = (macosDir: string) => Promise<unknown>;

/**
 * Re-apply the picker extension plant. Real impl: `extension/installer.ts`'s
 * `install` (idempotent self-heal — re-plants the loader cache, re-deletes the
 * sibling `.crx`). Tests: mock. Called once per watcher fire, not per dir.
 */
export type WatcherEnsureExtensionFn = () => Promise<unknown>;

/** Line-oriented logger. Runtime: `console.error`. Tests: `vi.fn`. */
export type WatcherLogger = (message: string) => void;

/** Outcome of the once-per-fire picker extension self-heal. */
export type WatcherExtensionOutcome =
	| { status: "reapplied" }
	| { status: "failed"; error: string }
	| { status: "skipped"; reason: string };

/** Structured summary returned to callers (and used in tests). */
export type WatcherSummary = {
	installed: string[];
	failed: Array<{ path: string; error: string }>;
	skipped: Array<{ path: string; reason: string }>;
	/** Result of the once-per-fire picker extension re-apply. */
	extension: WatcherExtensionOutcome;
};

/** Options for `runWatcher`. All fields are required — no ambient defaults. */
export type RunWatcherOpts = {
	parentDir: string;
	fs: FsPort;
	install: WatcherInstallFn;
	ensureExtension: WatcherEnsureExtensionFn;
	log: WatcherLogger;
	flag: boolean;
};

/**
 * Scan → reconcile → per-dir install. One failing dir logs + records but does
 * NOT abort the loop. Never throws.
 *
 * The `install` callback receives the `Contents/MacOS/` directory (not the
 * version dir) — that is the path PR2's `installer.install` expects.
 *
 * @param {RunWatcherOpts} opts - Fully-explicit deps + resolved flag.
 * @returns {Promise<WatcherSummary>} Per-action outcome.
 */
export async function runWatcher(opts: RunWatcherOpts): Promise<WatcherSummary> {
	const { parentDir, fs, install, ensureExtension, log, flag } = opts;
	const states = scanClaudeCodeDirs(parentDir, fs);
	const actions = reconcile(states, { flag });
	const summary: WatcherSummary = {
		installed: [],
		failed: [],
		skipped: actions.skip,
		extension: { status: "skipped", reason: "flag-off" },
	};
	for (const s of actions.skip) {
		log(`skip ${s.path}: ${s.reason}`);
	}
	const outcomes = await Promise.allSettled(
		actions.install.map(async (versionDir) => {
			const macosDir = join(versionDir, "claude.app", "Contents", "MacOS");
			await install(macosDir);
			return versionDir;
		}),
	);
	for (const [i, o] of outcomes.entries()) {
		// `outcomes` and `actions.install` are 1:1; the index is always valid.
		const versionDir = actions.install[i] as string;
		if (o.status === "fulfilled") {
			summary.installed.push(o.value);
			log(`installed ${o.value}`);
		} else {
			const error = o.reason instanceof Error ? o.reason.message : String(o.reason);
			summary.failed.push({ path: versionDir, error });
			log(`failed ${versionDir}: ${error}`);
		}
	}
	// Once-per-fire picker extension self-heal, gated on the same resolved flag
	// as the shim reconcile. Isolated: a throw here is recorded, never rethrown,
	// so it cannot mask or abort the CLI-shim outcome above.
	summary.extension = await healExtension(ensureExtension, log, flag);
	return summary;
}

/** A live recursive watch. `close()` detaches it. Matches `fs.watch`'s handle. */
export type ResidentWatch = { close: () => void };

/**
 * Deps for `watchResident`. Extends `RunWatcherOpts` with the ports the
 * resident loop needs, all injectable so the loop is unit-testable without a
 * real filesystem or wall-clock:
 *
 *   - `watch` — register ONE recursive watch on a path; each change calls
 *     `onEvent`. Runtime binds `fs.watch(path, { recursive: true }, ...)`.
 *   - `setTimer` / `clearTimer` — schedule and cancel the debounce. Default to
 *     `setTimeout` / `clearTimeout` when omitted.
 *   - `debounceMs` — collapse a burst of change events into one pass. Default
 *     150ms. Claude's relaunch writes several files in quick succession (and our
 *     own rename+plant fires more), so debouncing keeps that to a single pass.
 */
export type ResidentWatchDeps = RunWatcherOpts & {
	watch: (path: string, onEvent: () => void) => ResidentWatch;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
	debounceMs?: number;
};

/** Handle for a running resident watch. `close()` tears it fully down. */
export type ResidentWatchHandle = { close: () => void };

const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Hold a resident recursive watch on the claude-code parent and re-plant the
 * shim the instant Claude rewrites the `claude` binary.
 *
 * This replaces the spawned-per-event model that lost the launch race: the
 * daemon runs an initial catch-up pass on boot, then reacts to every change
 * under `parentDir` with a debounced `runWatcher`. Because `runWatcher` (via
 * `reconcile`) skips already-installed dirs, the pass is idempotent, so the
 * writes OUR OWN plant triggers collapse into one no-op pass rather than an
 * install loop.
 *
 * The event path never throws: a failing pass is logged through `opts.log`,
 * not propagated, so one bad reconcile can't kill the resident process (launchd
 * would restart it, but a silent live loop is worse than a logged miss).
 *
 * @param {ResidentWatchDeps} deps - Watcher opts plus the watch/timer ports.
 * @returns {ResidentWatchHandle} Handle whose `close()` closes the watch and
 *   cancels any pending debounced pass.
 */
export function watchResident(deps: ResidentWatchDeps): ResidentWatchHandle {
	// Pin the token type: the ambient `setTimeout` merges the DOM (`number`) and
	// Node (`Timeout`) overloads, so annotate the bindings to the single return
	// the injected port declares and keep `pending` assignable from both.
	type TimerToken = ReturnType<typeof setTimeout>;
	const setTimer: (fn: () => void, ms: number) => TimerToken = deps.setTimer ?? setTimeout;
	const clearTimer: (t: TimerToken) => void = deps.clearTimer ?? clearTimeout;
	const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	// `runWatcher` already catches per-dir and extension failures; this guard
	// covers a throw from the scan/reconcile prelude so the event path is total.
	const runPass = async (): Promise<void> => {
		try {
			await runWatcher(deps);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log(`watch pass failed: ${message}`);
		}
	};
	let pending: TimerToken | undefined;
	// Fire-and-forget: the initial catch-up runs, errors land in the log, and we
	// don't block registering the watch on it.
	// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget; runPass catches its own errors
	runPass();
	const watch = deps.watch(deps.parentDir, () => {
		if (pending !== undefined) {
			clearTimer(pending);
		}
		pending = setTimer(() => {
			pending = undefined;
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget; runPass catches its own errors
			runPass();
		}, debounceMs);
	});
	return {
		close: () => {
			if (pending !== undefined) {
				clearTimer(pending);
				pending = undefined;
			}
			watch.close();
		},
	};
}

/**
 * Run the picker extension re-apply exactly once. Flag-off short-circuits to a
 * `skipped` outcome with zero side effects (the flag-off no-op contract). A
 * thrown error is caught and returned as `failed`, never rethrown.
 *
 * @param {WatcherEnsureExtensionFn} ensureExtension - Idempotent re-plant.
 * @param {WatcherLogger} log - Line logger.
 * @param {boolean} flag - Resolved CLAUDE_MULTIACCT_ENABLE_SHIM state.
 * @returns {Promise<WatcherExtensionOutcome>} Per-fire extension outcome.
 */
async function healExtension(
	ensureExtension: WatcherEnsureExtensionFn,
	log: WatcherLogger,
	flag: boolean,
): Promise<WatcherExtensionOutcome> {
	if (!flag) {
		log("extension: skip (flag-off)");
		return { status: "skipped", reason: "flag-off" };
	}
	try {
		await ensureExtension();
		log("extension: reapplied");
		return { status: "reapplied" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`extension failed: ${message}`);
		return { status: "failed", error: message };
	}
}
