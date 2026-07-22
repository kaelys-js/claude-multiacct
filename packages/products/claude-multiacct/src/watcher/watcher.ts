/**
 * `@foundation/claude-multiacct` — watcher runtime entry.
 *
 * `runWatcher` is the fire-and-forget body that a launchd `WatchPaths` agent
 * invokes when Claude Desktop writes a new sibling into
 * `~/Library/Application Support/Claude/claude-code/`. It stitches
 * `scan → reconcile → install` and returns a summary the caller may log.
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
