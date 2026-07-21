/* eslint-disable vitest/no-conditional-in-test, jsdoc/require-returns, jsdoc/require-param, jsdoc/require-jsdoc */
/**
 * Intent: `runLegacyCleanup` MUST detect + prompt + remove every legacy
 * artifact class (clones, launchd, CLI binary, mirror stores, data dir).
 * It MUST early-return without prompting when nothing was found. It
 * MUST respect assumeYes. Individual failures per artifact MUST NOT
 * abort the run — everything else still gets removed.
 *
 * Adversarial: remove the isEmpty early-return and the "nothing detected"
 * test starts asking for confirmation — RED. Remove the try/catch around
 * removeCloneApp and one failing clone aborts the whole run — the
 * "partial failure" test flips RED.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type LegacyArtifacts,
	type LegacyCleanupPorts,
	runLegacyCleanup,
	summarize,
} from "./legacy-cleanup.ts";

const EMPTY: LegacyArtifacts = {
	cloneApps: [],
	launchdPlists: [],
	legacyCli: undefined,
	mirrorStores: [],
	legacyDataDir: undefined,
};

function mkPorts(detected: LegacyArtifacts, overrides: Partial<LegacyCleanupPorts> = {}): LegacyCleanupPorts {
	return {
		detect: () => Promise.resolve(detected),
		promptConfirm: () => Promise.resolve(true),
		removeCloneApp: () => Promise.resolve(),
		removeLaunchdPlist: () => Promise.resolve(),
		removeLegacyCli: () => Promise.resolve(),
		removeMirrorStore: () => Promise.resolve(),
		removeLegacyDataDir: () => Promise.resolve(),
		logger: { log: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>() },
		...overrides,
	};
}

describe("runLegacyCleanup", () => {
	it("early-returns without prompting when nothing detected", async () => {
		const prompt = vi.fn<(s: string) => Promise<boolean>>(() => Promise.resolve(true));
		const outcome = await runLegacyCleanup(mkPorts(EMPTY, { promptConfirm: prompt }));
		expect(prompt).not.toHaveBeenCalled();
		expect(outcome.removed.cloneApps).toEqual([]);
		expect(outcome.skipped).toBe(false);
	});

	it("prompts once and removes everything when user confirms", async () => {
		const detected: LegacyArtifacts = {
			cloneApps: ["/Applications/Claude Account Gmail.app"],
			launchdPlists: ["/Users/x/Library/LaunchAgents/com.user.claude-sessions-sync.plist"],
			legacyCli: "/Users/x/.local/bin/claude-multiacct",
			mirrorStores: ["/Users/x/Library/Application Support/Claude-Gmail"],
			legacyDataDir: "/Users/x/.claude-multiacct",
		};
		const removeClone = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removePlist = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removeCli = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removeMirror = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removeData = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const prompt = vi.fn<(s: string) => Promise<boolean>>(() => Promise.resolve(true));
		const outcome = await runLegacyCleanup(
			mkPorts(detected, {
				removeCloneApp: removeClone,
				removeLaunchdPlist: removePlist,
				removeLegacyCli: removeCli,
				removeMirrorStore: removeMirror,
				removeLegacyDataDir: removeData,
				promptConfirm: prompt,
			}),
		);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(removeClone).toHaveBeenCalledWith(detected.cloneApps[0]);
		expect(removePlist).toHaveBeenCalledWith(detected.launchdPlists[0]);
		expect(removeCli).toHaveBeenCalledWith(detected.legacyCli);
		expect(removeMirror).toHaveBeenCalledWith(detected.mirrorStores[0]);
		expect(removeData).toHaveBeenCalledWith(detected.legacyDataDir);
		expect(outcome.removed.cloneApps).toEqual(detected.cloneApps);
		expect(outcome.removed.legacyCli).toBe(detected.legacyCli);
		expect(outcome.failed).toEqual([]);
	});

	it("skips removal when user declines the prompt", async () => {
		const detected: LegacyArtifacts = { ...EMPTY, cloneApps: ["/x/A.app"] };
		const removeClone = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const outcome = await runLegacyCleanup(
			mkPorts(detected, {
				promptConfirm: () => Promise.resolve(false),
				removeCloneApp: removeClone,
			}),
		);
		expect(removeClone).not.toHaveBeenCalled();
		expect(outcome.skipped).toBe(true);
		expect(outcome.removed.cloneApps).toEqual([]);
	});

	it("assumeYes bypasses the prompt", async () => {
		const detected: LegacyArtifacts = { ...EMPTY, cloneApps: ["/x/A.app"] };
		const prompt = vi.fn<(s: string) => Promise<boolean>>(() => Promise.resolve(true));
		const removeClone = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		await runLegacyCleanup(
			mkPorts(detected, {
				promptConfirm: prompt,
				removeCloneApp: removeClone,
			}),
			{ assumeYes: true },
		);
		expect(prompt).not.toHaveBeenCalled();
		expect(removeClone).toHaveBeenCalledWith("/x/A.app");
	});

	it("classifies per-artifact failures without aborting the whole run", async () => {
		const detected: LegacyArtifacts = {
			...EMPTY,
			cloneApps: ["/x/A.app", "/x/B.app"],
		};
		let call = 0;
		const removeClone = vi.fn<(p: string) => Promise<void>>((_p: string) => {
			call += 1;
			if (call === 1) {
				return Promise.reject(new Error("EACCES"));
			}
			return Promise.resolve();
		});
		const outcome = await runLegacyCleanup(
			mkPorts(detected, { removeCloneApp: removeClone }),
			{ assumeYes: true },
		);
		expect(outcome.failed).toHaveLength(1);
		expect(outcome.failed[0]!.reason).toContain("EACCES");
		expect(outcome.removed.cloneApps).toEqual(["/x/B.app"]);
	});
});

describe("summarize", () => {
	it("lists each detected artifact class + counts", () => {
		const s = summarize({
			cloneApps: ["/a.app", "/b.app"],
			launchdPlists: ["/x.plist"],
			legacyCli: "/usr/local/bin/claude-multiacct",
			mirrorStores: ["/store"],
			legacyDataDir: "/dir",
		});
		expect(s).toContain("Clone apps (2)");
		expect(s).toContain("Launchd agents (1)");
		expect(s).toContain("Legacy CLI:");
		expect(s).toContain("Mirror stores (1)");
		expect(s).toContain("Legacy data dir:");
		expect(s).toContain("Remove all? [y/N]");
	});

	it("omits empty sections", () => {
		const s = summarize({
			cloneApps: ["/a.app"],
			launchdPlists: [],
			legacyCli: undefined,
			mirrorStores: [],
			legacyDataDir: undefined,
		});
		expect(s).toContain("Clone apps (1)");
		expect(s).not.toContain("Launchd agents");
		expect(s).not.toContain("Legacy CLI:");
		expect(s).not.toContain("Mirror stores");
	});
});
