/**
 * `@foundation/claude-multiacct` — legacy-bash-tool cleanup on install.
 *
 * The TS system supersedes an older bash-based multi-clone tool. On a
 * machine that ran the bash tool, `cma install` detects + prompts to
 * remove its artifacts:
 *
 *   - `~/Applications/Claude Account *.app` — clone bundles the bash
 *     tool copied from `/Applications/Claude.app`.
 *   - Launchd agents (`com.user.claude-{sessions-sync, clone-refresh,
 *     primary-patch-refresh, metadata-symlink}.plist`) under
 *     `~/Library/LaunchAgents/`. Unload with `launchctl unload` + delete.
 *   - Legacy `bin/claude-multiacct` in `$PATH` (usually
 *     `~/.local/bin/claude-multiacct` from the bash tool's install).
 *   - `~/Library/Application Support/Claude-<label>/` mirror stores —
 *     the bash tool's per-account app-support dirs.
 *   - Legacy `~/.claude-multiacct-backups/` and pre-TS `~/.claude-
 *     multiacct/` layouts.
 *
 * All side effects injected via a `LegacyCleanupPorts` shape so tests
 * exercise every branch against fake fs / launchctl / path resolvers.
 * `--yes` skips the interactive confirm; the default is one prompt
 * listing every artifact class detected, then a single yes/no gate.
 *
 * Idempotent: safe to re-run against a partially-cleaned machine.
 *
 * @module
 */

/** Categorized listing of legacy artifacts we found. */
export type LegacyArtifacts = {
	/** Clone bundle absolute paths under `~/Applications/`. */
	cloneApps: string[];
	/** Launchd plist absolute paths under `~/Library/LaunchAgents/`. */
	launchdPlists: string[];
	/** Absolute path of a legacy `bin/claude-multiacct` in `$PATH`, if present. */
	legacyCli: string | undefined;
	/** Absolute paths of Claude-label mirror-store dirs under ~/Library/Application Support/. */
	mirrorStores: string[];
	/** Absolute path of the legacy `~/.claude-multiacct/` dir if present + old-shape. */
	legacyDataDir: string | undefined;
};

export type LegacyCleanupPorts = {
	/**
	 * Detect every legacy artifact class. Returns empty arrays / undefined
	 * for absent classes. Never throws.
	 */
	detect: () => Promise<LegacyArtifacts>;
	/**
	 * Prompt the user (once) with a summary of what was found and get
	 * yes/no consent. Called only when `assumeYes === false`.
	 */
	promptConfirm: (summary: string) => Promise<boolean>;
	/** Remove one clone app bundle (rm -rf). */
	removeCloneApp: (path: string) => Promise<void>;
	/** Unload + delete one launchd plist. */
	removeLaunchdPlist: (path: string) => Promise<void>;
	/** Remove the legacy `bin/claude-multiacct` binary. */
	removeLegacyCli: (path: string) => Promise<void>;
	/** Remove one Claude-<label>/ mirror store. */
	removeMirrorStore: (path: string) => Promise<void>;
	/** Remove the legacy `~/.claude-multiacct/` data dir. */
	removeLegacyDataDir: (path: string) => Promise<void>;
	logger: { log: (m: string) => void; warn: (m: string) => void };
};

export type CleanupOptions = {
	/** Skip the confirmation prompt (still detects + reports). */
	assumeYes?: boolean;
};

export type CleanupOutcome = {
	detected: LegacyArtifacts;
	skipped: boolean;
	removed: {
		cloneApps: string[];
		launchdPlists: string[];
		legacyCli: string | undefined;
		mirrorStores: string[];
		legacyDataDir: string | undefined;
	};
	failed: Array<{ path: string; reason: string }>;
};

/**
 * Detect legacy artifacts, prompt (unless `assumeYes`), remove.
 *
 * @param {LegacyCleanupPorts} ports - Injected side-effects.
 * @param {CleanupOptions} opts - Options bag.
 * @returns {Promise<CleanupOutcome>} Structured outcome.
 */
export async function runLegacyCleanup(
	ports: LegacyCleanupPorts,
	opts: CleanupOptions = {},
): Promise<CleanupOutcome> {
	const detected = await ports.detect();
	const empty: CleanupOutcome = {
		detected,
		skipped: false,
		removed: {
			cloneApps: [],
			launchdPlists: [],
			legacyCli: undefined,
			mirrorStores: [],
			legacyDataDir: undefined,
		},
		failed: [],
	};

	if (isEmpty(detected)) {
		return empty;
	}

	const summary = summarize(detected);
	if (opts.assumeYes !== true) {
		const ok = await ports.promptConfirm(summary);
		if (!ok) {
			ports.logger.log("legacy-cleanup: user declined; leaving artifacts in place");
			return { ...empty, skipped: true };
		}
	}

	const outcome: CleanupOutcome = empty;
	for (const p of detected.cloneApps) {
		try {
			// eslint-disable-next-line no-await-in-loop -- sequential; each rm is independent I/O
			await ports.removeCloneApp(p);
			outcome.removed.cloneApps.push(p);
			ports.logger.log(`legacy-cleanup: removed clone app ${p}`);
		} catch (error) {
			outcome.failed.push({ path: p, reason: errMsg(error) });
			ports.logger.warn(`legacy-cleanup: failed to remove clone app ${p}: ${errMsg(error)}`);
		}
	}
	for (const p of detected.launchdPlists) {
		try {
			// eslint-disable-next-line no-await-in-loop -- sequential
			await ports.removeLaunchdPlist(p);
			outcome.removed.launchdPlists.push(p);
			ports.logger.log(`legacy-cleanup: unloaded + removed launchd plist ${p}`);
		} catch (error) {
			outcome.failed.push({ path: p, reason: errMsg(error) });
			ports.logger.warn(`legacy-cleanup: failed to remove launchd plist ${p}: ${errMsg(error)}`);
		}
	}
	if (detected.legacyCli !== undefined) {
		try {
			await ports.removeLegacyCli(detected.legacyCli);
			outcome.removed.legacyCli = detected.legacyCli;
			ports.logger.log(`legacy-cleanup: removed legacy CLI ${detected.legacyCli}`);
		} catch (error) {
			outcome.failed.push({ path: detected.legacyCli, reason: errMsg(error) });
			ports.logger.warn(`legacy-cleanup: failed to remove legacy CLI: ${errMsg(error)}`);
		}
	}
	for (const p of detected.mirrorStores) {
		try {
			// eslint-disable-next-line no-await-in-loop -- sequential
			await ports.removeMirrorStore(p);
			outcome.removed.mirrorStores.push(p);
			ports.logger.log(`legacy-cleanup: removed mirror store ${p}`);
		} catch (error) {
			outcome.failed.push({ path: p, reason: errMsg(error) });
			ports.logger.warn(`legacy-cleanup: failed to remove mirror store ${p}: ${errMsg(error)}`);
		}
	}
	if (detected.legacyDataDir !== undefined) {
		try {
			await ports.removeLegacyDataDir(detected.legacyDataDir);
			outcome.removed.legacyDataDir = detected.legacyDataDir;
			ports.logger.log(`legacy-cleanup: removed legacy data dir ${detected.legacyDataDir}`);
		} catch (error) {
			outcome.failed.push({ path: detected.legacyDataDir, reason: errMsg(error) });
			ports.logger.warn(`legacy-cleanup: failed to remove legacy data dir: ${errMsg(error)}`);
		}
	}
	return outcome;
}

function isEmpty(a: LegacyArtifacts): boolean {
	return (
		a.cloneApps.length === 0 &&
		a.launchdPlists.length === 0 &&
		a.legacyCli === undefined &&
		a.mirrorStores.length === 0 &&
		a.legacyDataDir === undefined
	);
}

/**
 * Build the human-facing summary for the confirm prompt.
 *
 * @param {LegacyArtifacts} a - Detected artifacts.
 * @returns {string} Multi-line summary.
 */
export function summarize(a: LegacyArtifacts): string {
	const lines: string[] = ["Legacy claude-multiacct (bash tool) artifacts detected:"];
	if (a.cloneApps.length > 0) {
		lines.push("", `Clone apps (${String(a.cloneApps.length)}):`);
		for (const p of a.cloneApps) {
			lines.push(`  - ${p}`);
		}
	}
	if (a.launchdPlists.length > 0) {
		lines.push("", `Launchd agents (${String(a.launchdPlists.length)}):`);
		for (const p of a.launchdPlists) {
			lines.push(`  - ${p}`);
		}
	}
	if (a.legacyCli !== undefined) {
		lines.push("", `Legacy CLI: ${a.legacyCli}`);
	}
	if (a.mirrorStores.length > 0) {
		lines.push("", `Mirror stores (${String(a.mirrorStores.length)}):`);
		for (const p of a.mirrorStores) {
			lines.push(`  - ${p}`);
		}
	}
	if (a.legacyDataDir !== undefined) {
		lines.push("", `Legacy data dir: ${a.legacyDataDir}`);
	}
	lines.push(
		"",
		"These artifacts will be moved to ~/.Trash/ (not permanently deleted).",
		"To proceed, type PURGE (in capitals) and press Enter. Anything else aborts.",
	);
	return lines.join("\n");
}

/**
 * Coerce a throwable into a printable string.
 *
 * @param {unknown} error - Thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
