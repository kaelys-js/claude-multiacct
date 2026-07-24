/**
 * Intent: `runWatcher` MUST survive a per-dir install failure. launchd fires
 * the agent once per WatchPaths event; if one bad dir aborted the whole
 * pass, a single broken sibling would starve every other pending install
 * until the user noticed. The "one fails, two succeed" case is adversarial —
 * removing the per-dir isolation in `watcher.ts` (e.g. switching to
 * `Promise.all` without settling) flips it red.
 *
 * The picker extension self-heal runs once per fire and is independent of the
 * per-dir CLI-shim work: it MUST be gated on the same flag (flag-off → the
 * heal is a total no-op, `ensureExtension` never called) and a throw inside it
 * MUST be recorded, not rethrown, so it can neither mask nor abort the shim
 * outcomes. Dropping either property flips the dedicated cases red.
 *
 * The flag-off assertion is a sanity double-check that gets us the routing
 * for free (the real gate lives in `reconcile.test.ts`).
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FsPort } from "./fs-port.ts";
import {
	runWatcher,
	type ResidentWatch,
	type ResidentWatchDeps,
	watchResident,
	type WatcherEnsureExtensionFn,
	type WatcherInstallFn,
	type WatcherLogger,
} from "./watcher.ts";

/** Shared no-op callback + watch handle so the fixtures satisfy the typed ports. */
const noop = (): void => {
	// intentional no-op
};
const noopWatch: ResidentWatchDeps["watch"] = () => ({ close: noop });

/**
 * A logger stub that throws `thrown` on the unguarded "skip" line runWatcher
 * emits, and forwards every other line to `seen`. Lives at module scope so the
 * throw-branch is infrastructure, not a conditional inside a test body.
 *
 * @param {(m: string) => void} seen - Sink for non-throwing lines.
 * @param {unknown} thrown - Value thrown when a "skip" line is logged.
 * @returns {WatcherLogger} The stub logger.
 */
function skipThrowingLog(seen: (m: string) => void, thrown: unknown): WatcherLogger {
	return (m) => {
		if (m.startsWith("skip")) {
			throw thrown;
		}
		seen(m);
	};
}

/**
 * Build a fake fs whose direct children under `parent` classify as
 * `uninstalled` (each has `claude` present, no `claude.real`).
 *
 * @param {string} parent - Parent dir.
 * @param {readonly string[]} versions - Sibling version dir names.
 * @returns {FsPort} Stub fs.
 */
function threeSiblingFs(parent: string, versions: readonly string[]): FsPort {
	const macosOf = (v: string): string => `${parent}/${v}/claude.app/Contents/MacOS`;
	const paths = new Set<string>();
	for (const v of versions) {
		paths.add(`${parent}/${v}`);
		paths.add(macosOf(v));
		paths.add(`${macosOf(v)}/claude`);
	}
	return {
		readdirSync: (p) => (p === parent ? [...versions] : []),
		statSync: (p): { isDirectory: () => boolean; size: number } => {
			const isDir = (): boolean => !p.endsWith("/claude");
			return { isDirectory: isDir, size: 42 };
		},
		existsSync: (p) => paths.has(p),
	};
}

const parent = "/tmp/claude-code";
const noopLog: WatcherLogger = () => {
	// intentional no-op
};
const succeedInstall: WatcherInstallFn = () => Promise.resolve({ ok: true });
const failOn1_3_0: WatcherInstallFn = (dir) =>
	dir.includes("1.3.0") ? Promise.reject(new Error("codesign refused")) : Promise.resolve();
// oxlint-disable-next-line prefer-promise-reject-errors
const rejectRawString: WatcherInstallFn = () => Promise.reject("raw string thrown");
// Default extension heal that resolves — the common path.
const okEnsure: WatcherEnsureExtensionFn = () => Promise.resolve({ installed: true });

describe("runWatcher", () => {
	it("flag off → zero installs, every dir routed to skipped (reason 'flag-off')", async () => {
		const install = vi.fn<WatcherInstallFn>();
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		const log = vi.fn<WatcherLogger>();
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3"]),
			install,
			ensureExtension,
			log,
			flag: false,
		});
		expect(install).not.toHaveBeenCalled();
		// Flag-off is a TOTAL no-op: the extension heal must not run either.
		expect(ensureExtension).not.toHaveBeenCalled();
		expect(summary.installed).toStrictEqual([]);
		expect(summary.failed).toStrictEqual([]);
		expect(summary.skipped).toStrictEqual([{ path: `${parent}/1.2.3`, reason: "flag-off" }]);
		expect(summary.extension).toStrictEqual({ status: "skipped", reason: "flag-off" });
	});

	it("flag on, 3 uninstalled dirs, install() succeeds for all → summary.installed has all 3", async () => {
		const install = vi.fn<WatcherInstallFn>(succeedInstall);
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3", "1.3.0", "1.4.0"]),
			install,
			ensureExtension,
			log: noopLog,
			flag: true,
		});
		expect(summary.installed.toSorted()).toStrictEqual([
			`${parent}/1.2.3`,
			`${parent}/1.3.0`,
			`${parent}/1.4.0`,
		]);
		expect(summary.failed).toStrictEqual([]);
		// install() is called with the MacOS dir, not the version dir.
		expect(install).toHaveBeenNthCalledWith(
			1,
			join(`${parent}/1.2.3`, "claude.app", "Contents", "MacOS"),
		);
		// The picker heal fires exactly once per watcher pass, regardless of the
		// number of CLI dirs.
		expect(ensureExtension).toHaveBeenCalledTimes(1);
		expect(summary.extension).toStrictEqual({ status: "reapplied" });
	});

	it("one dir throws → other dirs still install (ADVERSARIAL: drop the per-dir isolation and this goes red)", async () => {
		const log = vi.fn<WatcherLogger>();
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3", "1.3.0", "1.4.0"]),
			install: failOn1_3_0,
			ensureExtension: okEnsure,
			log,
			flag: true,
		});
		expect(summary.installed.toSorted()).toStrictEqual([`${parent}/1.2.3`, `${parent}/1.4.0`]);
		expect(summary.failed).toStrictEqual([{ path: `${parent}/1.3.0`, error: "codesign refused" }]);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/^failed .*1\.3\.0: codesign refused/u));
	});

	it("non-Error thrown value is coerced to string (defensive — install() is user-supplied)", async () => {
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3"]),
			install: rejectRawString,
			ensureExtension: okEnsure,
			log: noopLog,
			flag: true,
		});
		expect(summary.failed).toStrictEqual([{ path: `${parent}/1.2.3`, error: "raw string thrown" }]);
	});

	it("logs one line per skipped dir before entering the install loop", async () => {
		const log = vi.fn<WatcherLogger>();
		await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3"]),
			install: vi.fn<WatcherInstallFn>(),
			ensureExtension: okEnsure,
			log,
			flag: false,
		});
		expect(log).toHaveBeenCalledWith(`skip ${parent}/1.2.3: flag-off`);
	});

	it("flag on, ensureExtension throws Error → recorded as failed, shim installs still succeed (ADVERSARIAL: rethrow it and this goes red)", async () => {
		const install = vi.fn<WatcherInstallFn>(succeedInstall);
		const log = vi.fn<WatcherLogger>();
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3"]),
			install,
			ensureExtension: () => Promise.reject(new Error("dist/extension missing")),
			log,
			flag: true,
		});
		// The CLI-shim half is unaffected by the extension failure.
		expect(summary.installed).toStrictEqual([`${parent}/1.2.3`]);
		expect(summary.extension).toStrictEqual({
			status: "failed",
			error: "dist/extension missing",
		});
		expect(log).toHaveBeenCalledWith("extension failed: dist/extension missing");
	});

	it("flag on, ensureExtension throws a non-Error → coerced to string", async () => {
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, []),
			install: vi.fn<WatcherInstallFn>(),
			// oxlint-disable-next-line prefer-promise-reject-errors
			ensureExtension: () => Promise.reject("cache dir vanished"),
			log: noopLog,
			flag: true,
		});
		expect(summary.extension).toStrictEqual({ status: "failed", error: "cache dir vanished" });
	});

	it("flag on but no CLI dirs present → still runs the picker heal once (update path where only the plant needs healing)", async () => {
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, []),
			install: vi.fn<WatcherInstallFn>(),
			ensureExtension,
			log: noopLog,
			flag: true,
		});
		expect(summary.installed).toStrictEqual([]);
		expect(ensureExtension).toHaveBeenCalledTimes(1);
		expect(summary.extension).toStrictEqual({ status: "reapplied" });
	});
});

/**
 * Build a fake fs whose direct children under `parent` classify as `installed`
 * (each has `claude` AND a non-empty `claude.real`). A pass over this fs plants
 * nothing — the property the resident loop leans on so its OWN rename+plant
 * events don't spin an install loop.
 *
 * @param {string} parentDir - Parent dir.
 * @param {readonly string[]} versions - Sibling version dir names.
 * @returns {FsPort} Stub fs.
 */
function installedSiblingFs(parentDir: string, versions: readonly string[]): FsPort {
	const macosOf = (v: string): string => `${parentDir}/${v}/claude.app/Contents/MacOS`;
	const paths = new Set<string>();
	for (const v of versions) {
		paths.add(`${parentDir}/${v}`);
		paths.add(macosOf(v));
		paths.add(`${macosOf(v)}/claude`);
		paths.add(`${macosOf(v)}/claude.real`);
	}
	return {
		readdirSync: (p) => (p === parentDir ? [...versions] : []),
		statSync: (): { isDirectory: () => boolean; size: number } => ({
			isDirectory: (): boolean => true,
			size: 42,
		}),
		existsSync: (p) => paths.has(p),
	};
}

/**
 * Deterministic timer queue for the debounce. `setTimer` enqueues, `clearTimer`
 * drops, `flush` fires everything still pending. Lets a test drive the debounce
 * by hand instead of racing the wall clock.
 *
 * @returns {object} `setTimer` / `clearTimer` ports plus `flush` and `pending`.
 */
function manualTimers(): {
	setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer: (t: ReturnType<typeof setTimeout>) => void;
	flush: () => void;
	pending: () => number;
} {
	let queue: Array<{ fn: () => void }> = [];
	return {
		setTimer: (fn) => {
			const token = { fn };
			queue.push(token);
			return token as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (t) => {
			queue = queue.filter((x) => x !== (t as unknown as { fn: () => void }));
		},
		flush: () => {
			const q = queue;
			queue = [];
			for (const t of q) {
				t.fn();
			}
		},
		pending: () => queue.length,
	};
}

/**
 * Intent: the resident loop is the fix for the launch race. The old model
 * cold-spawned a fresh launchd agent per WatchPaths event and only re-planted
 * ~13-19s after Claude launched, well after the session already booted on the
 * vanilla 250MB binary. `watchResident` must instead run a catch-up pass on
 * boot, re-plant on every change to `claude`, debounce a write burst into ONE
 * pass, and — because `runWatcher` skips already-installed dirs — collapse the
 * events fired by its OWN rename+plant into a no-op rather than an install
 * loop. `close()` must fully detach so a shutdown can't leave a live watch or a
 * pending pass, and a throwing pass must never take the resident process down.
 */
describe("watchResident", () => {
	it("runs an initial catch-up pass on construction (heals whatever booted before the daemon)", async () => {
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		const timers = manualTimers();
		watchResident({
			parentDir: parent,
			fs: installedSiblingFs(parent, ["1.2.3"]),
			install: vi.fn<WatcherInstallFn>(succeedInstall),
			ensureExtension,
			log: noopLog,
			flag: true,
			watch: noopWatch,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		// One pass fires with no event at all: the boot catch-up.
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(1));
	});

	it("a change event schedules a debounced pass — not an immediate one — then runs it on flush", async () => {
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		const timers = manualTimers();
		let onEvent: () => void = noop;
		watchResident({
			parentDir: parent,
			fs: installedSiblingFs(parent, ["1.2.3"]),
			install: vi.fn<WatcherInstallFn>(succeedInstall),
			ensureExtension,
			log: noopLog,
			flag: true,
			watch: (_path, cb): ResidentWatch => {
				onEvent = cb;
				return { close: noop };
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(1));
		onEvent();
		// Debounced: the pass is queued, not run inline. If it ran on the event
		// itself, the count would already be 2 here.
		expect(ensureExtension).toHaveBeenCalledTimes(1);
		expect(timers.pending()).toBe(1);
		timers.flush();
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(2));
	});

	it("watch() is bound to the parent dir it must observe", () => {
		const watch = vi.fn<ResidentWatchDeps["watch"]>(noopWatch);
		const timers = manualTimers();
		watchResident({
			parentDir: parent,
			fs: installedSiblingFs(parent, []),
			install: vi.fn<WatcherInstallFn>(),
			ensureExtension: okEnsure,
			log: noopLog,
			flag: true,
			watch,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		expect(watch).toHaveBeenCalledTimes(1);
		expect(watch.mock.calls[0]?.[0]).toBe(parent);
	});

	it("a burst of rapid events collapses to ONE pass and plants nothing (ADVERSARIAL: our own rename+plant must not spin an install loop)", async () => {
		const install = vi.fn<WatcherInstallFn>(succeedInstall);
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		const timers = manualTimers();
		let onEvent: () => void = noop;
		watchResident({
			parentDir: parent,
			// Already installed: reconcile routes every dir to skip, so a pass over
			// this fs must never call install(). That is the no-loop property.
			fs: installedSiblingFs(parent, ["1.2.3", "1.3.0"]),
			install,
			ensureExtension,
			log: noopLog,
			flag: true,
			watch: (_path, cb): ResidentWatch => {
				onEvent = cb;
				return { close: noop };
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(1));
		// Five writes land in the debounce window — each resets the single timer.
		for (let i = 0; i < 5; i++) {
			onEvent();
		}
		expect(timers.pending()).toBe(1);
		timers.flush();
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(2));
		// The burst produced ONE extra pass, not five.
		expect(ensureExtension).toHaveBeenCalledTimes(2);
		// And no pass ever tried to (re)install an already-planted dir.
		expect(install).not.toHaveBeenCalled();
	});

	it("close() closes the watch and cancels a pending pass so no further pass runs", async () => {
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		const close = vi.fn<() => void>();
		const timers = manualTimers();
		let onEvent: () => void = noop;
		const handle = watchResident({
			parentDir: parent,
			fs: installedSiblingFs(parent, ["1.2.3"]),
			install: vi.fn<WatcherInstallFn>(succeedInstall),
			ensureExtension,
			log: noopLog,
			flag: true,
			watch: (_path, cb): ResidentWatch => {
				onEvent = cb;
				return { close };
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(1));
		onEvent();
		expect(timers.pending()).toBe(1);
		handle.close();
		// The watch is detached and the queued pass was cancelled.
		expect(close).toHaveBeenCalledTimes(1);
		expect(timers.pending()).toBe(0);
		timers.flush();
		await Promise.resolve();
		expect(ensureExtension).toHaveBeenCalledTimes(1);
	});

	it("a throwing pass is caught and logged, never taking the resident process down (ADVERSARIAL: drop the guard and the rejection escapes)", async () => {
		const seen = vi.fn<WatcherLogger>();
		// runWatcher guards per-dir installs and the extension heal, but its
		// scan/reconcile prelude logs a "skip" line unguarded. A log sink that
		// throws there makes the whole pass reject; watchResident's own try/catch
		// must swallow it and record a "watch pass failed:" line instead.
		const throwingLog = skipThrowingLog(seen, new Error("log sink died"));
		const timers = manualTimers();
		watchResident({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3"]),
			install: vi.fn<WatcherInstallFn>(),
			ensureExtension: okEnsure,
			log: throwingLog,
			flag: false,
			watch: noopWatch,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		await vi.waitFor(() =>
			expect(seen).toHaveBeenCalledWith(
				expect.stringMatching(/^watch pass failed: log sink died/u),
			),
		);
	});

	it("a non-Error rejection from a pass is coerced to string in the failure log", async () => {
		const seen = vi.fn<WatcherLogger>();
		const throwingLog = skipThrowingLog(seen, "raw string sink failure");
		const timers = manualTimers();
		watchResident({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3"]),
			install: vi.fn<WatcherInstallFn>(),
			ensureExtension: okEnsure,
			log: throwingLog,
			flag: false,
			watch: noopWatch,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		await vi.waitFor(() =>
			expect(seen).toHaveBeenCalledWith("watch pass failed: raw string sink failure"),
		);
	});

	it("falls back to real setTimeout/clearTimeout when no timer ports are injected", async () => {
		const ensureExtension = vi.fn<WatcherEnsureExtensionFn>(okEnsure);
		let onEvent: () => void = noop;
		const handle = watchResident({
			parentDir: parent,
			fs: installedSiblingFs(parent, ["1.2.3"]),
			install: vi.fn<WatcherInstallFn>(succeedInstall),
			ensureExtension,
			log: noopLog,
			flag: true,
			watch: (_path, cb): ResidentWatch => {
				onEvent = cb;
				return { close: noop };
			},
			debounceMs: 1,
		});
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(1));
		onEvent();
		// Real timers: the default setTimeout drives the debounce and a real
		// clearTimeout runs inside close() after the pass lands.
		await vi.waitFor(() => expect(ensureExtension).toHaveBeenCalledTimes(2));
		handle.close();
	});
});
