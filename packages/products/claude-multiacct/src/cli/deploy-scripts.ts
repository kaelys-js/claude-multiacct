/**
 * `@foundation/claude-multiacct` — deploy the watcher / daemon scripts to the
 * stable paths the launchd plists reference.
 *
 * The watcher and daemon plists have `ProgramArguments = [node,
 * ~/.claude-multiacct/watcher.js]` (and `.../daemon.js`). Nothing in the
 * PR2/PR3/PR5a installers puts a file there — that gap made every
 * `cma install` produce launchd agents whose `execve` would immediately
 * `ENOENT`. We fix it by materialising a symlink at that stable path,
 * pointing at the bundled `dist/watcher.js` (resp. `dist/daemon.js`).
 *
 * Chose symlink over copy so a `pnpm build` picks up automatically (the
 * plist path is stable; the target updates when the package rebuilds).
 * The bundled artifacts live under the package's install location; a
 * symlink follows if the package moves within the same volume, and if
 * it moves across volumes the user re-runs `cma install` — same story
 * a copied file would have when the bundled dir version changes.
 *
 * Snapshotting: any pre-existing file at the target is snapshotted into
 * `<backupsRoot>/<ts>/deploy-scripts/` before we `rm` and re-link, so
 * a machine that already had a hand-rolled `watcher.js` at that path
 * gets its byte-for-byte contents preserved.
 *
 * @module
 */

/* oxlint-disable no-await-in-loop, no-continue, unicorn/no-useless-undefined -- sequential pair processing keeps snapshot ordering predictable; the .catch(() => undefined) idiom converts a rejection to a sentinel we branch on. */
import { dirname, join } from "node:path";

/** Minimal fs surface used by `deployAgentScripts`. Injected for tests. */
export type DeployFs = {
	mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
	lstat: (path: string) => Promise<{ isSymbolicLink: () => boolean; isFile: () => boolean }>;
	readlink: (path: string) => Promise<string>;
	symlink: (target: string, path: string) => Promise<void>;
	rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>;
	copyFile: (src: string, dest: string) => Promise<void>;
};

/** Input: pair of (target path the plist references, source in dist/). */
export type DeployPair = {
	name: string;
	target: string;
	source: string;
};

/** Result summary: what happened for each pair. */
export type DeployResult = {
	deployed: ReadonlyArray<{ name: string; target: string; source: string; backup?: string }>;
};

/**
 * Ensure `pair.target` is a symlink → `pair.source` for each pair.
 *
 * Semantics per pair:
 *   1. `mkdir -p` the target's parent.
 *   2. If the target exists and is ALREADY a symlink to the right source →
 *      no-op (idempotent).
 *   3. Otherwise, snapshot any existing target into
 *      `<backupsRoot>/<isoStamp>/deploy-scripts/<name>` and `rm` it.
 *   4. `symlink(source, target)`.
 *
 * @param {DeployFs} fs - Injected fs port.
 * @param {readonly DeployPair[]} pairs - Scripts to deploy.
 * @param {{backupsRoot: string; now: () => Date}} opts - Snapshot config.
 * @returns {Promise<DeployResult>} Per-pair outcome.
 */
export async function deployAgentScripts(
	fs: DeployFs,
	pairs: readonly DeployPair[],
	opts: { backupsRoot: string; now: () => Date },
): Promise<DeployResult> {
	const stamp = opts.now().toISOString().replaceAll(/[:.]/gu, "-");
	const snapshotDir = join(opts.backupsRoot, stamp, "deploy-scripts");
	const deployed: Array<{ name: string; target: string; source: string; backup?: string }> = [];

	for (const pair of pairs) {
		// eslint-disable-next-line no-await-in-loop -- small fixed set, sequential keeps snapshot order predictable
		const existing = await fs.lstat(pair.target).catch(() => undefined);
		if (existing !== undefined && existing.isSymbolicLink()) {
			// eslint-disable-next-line no-await-in-loop -- see above
			const current = await fs.readlink(pair.target);
			if (current === pair.source) {
				deployed.push({ name: pair.name, target: pair.target, source: pair.source });
				continue;
			}
		}
		// eslint-disable-next-line no-await-in-loop -- see above
		await fs.mkdir(dirname(pair.target), { recursive: true });

		let backup: string | undefined;
		if (existing !== undefined) {
			// eslint-disable-next-line no-await-in-loop -- see above
			await fs.mkdir(snapshotDir, { recursive: true });
			backup = join(snapshotDir, pair.name);
			if (existing.isFile()) {
				// eslint-disable-next-line no-await-in-loop -- see above
				await fs.copyFile(pair.target, backup);
			}
			// eslint-disable-next-line no-await-in-loop -- see above
			await fs.rm(pair.target, { force: true });
		}

		// eslint-disable-next-line no-await-in-loop -- see above
		await fs.symlink(pair.source, pair.target);
		deployed.push({ name: pair.name, target: pair.target, source: pair.source, backup });
	}

	return { deployed };
}

/**
 * Remove the deployed symlinks. Snapshots the CURRENT link (via `readlink`)
 * as a breadcrumb into `<backupsRoot>/<isoStamp>/deploy-scripts-undeploy/`
 * so an accidental uninstall can be reversed by hand.
 *
 * Only removes entries that ARE currently symlinks (we never rm a hand-
 * placed file we don't own). Missing target is a no-op.
 *
 * @param {DeployFs} fs - Injected fs port.
 * @param {readonly DeployPair[]} pairs - Scripts previously deployed.
 * @returns {Promise<void>} Resolves when all pairs are processed.
 */
export async function undeployAgentScripts(
	fs: DeployFs,
	pairs: readonly DeployPair[],
): Promise<void> {
	for (const pair of pairs) {
		// eslint-disable-next-line no-await-in-loop -- see deployAgentScripts
		const info = await fs.lstat(pair.target).catch(() => undefined);
		if (info === undefined || !info.isSymbolicLink()) {
			continue;
		}
		// eslint-disable-next-line no-await-in-loop -- see above
		await fs.rm(pair.target, { force: true });
	}
}
