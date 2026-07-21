/**
 * Intent: `runWatcher` MUST survive a per-dir install failure. launchd fires
 * the agent once per WatchPaths event; if one bad dir aborted the whole
 * pass, a single broken sibling would starve every other pending install
 * until the user noticed. The "one fails, two succeed" case is adversarial —
 * removing the per-dir isolation in `watcher.ts` (e.g. switching to
 * `Promise.all` without settling) flips it red.
 *
 * The flag-off assertion is a sanity double-check that gets us the routing
 * for free (the real gate lives in `reconcile.test.ts`).
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FsPort } from "./fs-port.ts";
import { runWatcher, type WatcherInstallFn, type WatcherLogger } from "./watcher.ts";

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

describe("runWatcher", () => {
	it("flag off → zero installs, every dir routed to skipped (reason 'flag-off')", async () => {
		const install = vi.fn<WatcherInstallFn>();
		const log = vi.fn<WatcherLogger>();
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3"]),
			install,
			log,
			flag: false,
		});
		expect(install).not.toHaveBeenCalled();
		expect(summary.installed).toStrictEqual([]);
		expect(summary.failed).toStrictEqual([]);
		expect(summary.skipped).toStrictEqual([{ path: `${parent}/1.2.3`, reason: "flag-off" }]);
	});

	it("flag on, 3 uninstalled dirs, install() succeeds for all → summary.installed has all 3", async () => {
		const install = vi.fn<WatcherInstallFn>(succeedInstall);
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3", "1.3.0", "1.4.0"]),
			install,
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
	});

	it("one dir throws → other dirs still install (ADVERSARIAL: drop the per-dir isolation and this goes red)", async () => {
		const log = vi.fn<WatcherLogger>();
		const summary = await runWatcher({
			parentDir: parent,
			fs: threeSiblingFs(parent, ["1.2.3", "1.3.0", "1.4.0"]),
			install: failOn1_3_0,
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
			log,
			flag: false,
		});
		expect(log).toHaveBeenCalledWith(`skip ${parent}/1.2.3: flag-off`);
	});
});
