/**
 * `@foundation/claude-multiacct` — watcher runtime entry.
 *
 * `runWatcher` is the fire-and-forget body that a launchd `WatchPaths` agent
 * invokes when Claude Desktop writes a new sibling into
 * `~/Library/Application Support/Claude/claude-code/`. It stitches
 * `scan → reconcile → install` and returns a summary the caller may log.
 *
 * Two behaviours are load-bearing:
 *
 *   - **Per-dir isolation** — one failing dir MUST NOT abort the others.
 *     The install loop uses a per-iteration try/catch and pushes failures into
 *     `summary.failed`. Adversarial: remove the try/catch and the "one dir
 *     fails, others still install" test in `watcher.test.ts` goes red.
 *   - **Flag routing lives in `reconcile`, not here** — this runtime just
 *     executes what reconcile plans, so the flag-off contract is verified by
 *     `reconcile.test.ts` and the watcher body stays trivial.
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

/** Line-oriented logger. Runtime: `console.error`. Tests: `vi.fn`. */
export type WatcherLogger = (message: string) => void;

/** Structured summary returned to callers (and used in tests). */
export type WatcherSummary = {
	installed: string[];
	failed: Array<{ path: string; error: string }>;
	skipped: Array<{ path: string; reason: string }>;
};

/** Options for `runWatcher`. All fields are required — no ambient defaults. */
export type RunWatcherOpts = {
	parentDir: string;
	fs: FsPort;
	install: WatcherInstallFn;
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
	const { parentDir, fs, install, log, flag } = opts;
	const states = scanClaudeCodeDirs(parentDir, fs);
	const actions = reconcile(states, { flag });
	const summary: WatcherSummary = {
		installed: [],
		failed: [],
		skipped: actions.skip,
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
	return summary;
}
