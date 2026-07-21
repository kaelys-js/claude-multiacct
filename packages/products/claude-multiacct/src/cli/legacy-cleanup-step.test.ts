/* eslint-disable vitest/no-conditional-in-test, jsdoc/require-returns, jsdoc/require-param, jsdoc/require-jsdoc */
/**
 * Intent: the install-pipeline `legacy-cleanup` step MUST be a thin wrapper
 * around `runLegacyCleanup` with a HARD safety default — a plain `cma install`
 * does not touch the user's clone apps, mirror stores, or launchd plists.
 * Opt-in is `purgeLegacy: true`; skipping the interactive prompt on top of
 * that requires `assumeYes: true`.
 *
 * Adversarial:
 *   - Flip the `purgeLegacy` default to `true` and the "default install does
 *     not detect legacy" test flips RED.
 *   - Remove the `try/catch` around `runLegacyCleanup` and the "detect
 *     throws" test flips RED.
 *   - Change the `flag !== true` gate and the "skips when flag=false" test
 *     flips RED.
 */

import { describe, expect, it, vi } from "vitest";
import type { LegacyArtifacts, LegacyCleanupPorts } from "./legacy-cleanup.ts";
import { makeLegacyCleanupStep } from "./legacy-cleanup-step.ts";

const EMPTY: LegacyArtifacts = {
	cloneApps: [],
	launchdPlists: [],
	legacyCli: undefined,
	mirrorStores: [],
	legacyDataDir: undefined,
};

function mkPorts(
	detected: LegacyArtifacts = EMPTY,
	overrides: Partial<LegacyCleanupPorts> = {},
): LegacyCleanupPorts {
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

describe("makeLegacyCleanupStep", () => {
	it("has name 'legacy-cleanup'", () => {
		const step = makeLegacyCleanupStep(mkPorts(), { purgeLegacy: true, assumeYes: true });
		expect(step.name).toBe("legacy-cleanup");
	});

	it("skips work when flag is false", async () => {
		const detect = vi.fn<() => Promise<LegacyArtifacts>>(() => Promise.resolve(EMPTY));
		const step = makeLegacyCleanupStep(mkPorts(EMPTY, { detect }), {
			purgeLegacy: true,
			assumeYes: true,
		});
		const result = await step.install(false);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("skipped");
		expect(detect).not.toHaveBeenCalled();
	});

	// The regression that motivated the safety gate: `cma install` with a
	// truthy env yes-shortcut deleted the user's clone apps. Now, default
	// install NEVER runs detection or removal — the caller must explicitly
	// pass `--purge-legacy` (mapped to `purgeLegacy: true`).
	it("default install (purgeLegacy=false) does NOT detect or remove anything", async () => {
		const detect = vi.fn<() => Promise<LegacyArtifacts>>(() =>
			Promise.resolve({
				cloneApps: ["/Applications/Claude Account Gmail.app"],
				launchdPlists: ["/Users/x/Library/LaunchAgents/com.user.claude-sessions-sync.plist"],
				legacyCli: undefined,
				mirrorStores: ["/Users/x/Library/Application Support/Claude-Gmail"],
				legacyDataDir: undefined,
			}),
		);
		const removeClone = vi.fn<(p: string) => Promise<void>>();
		const removePlist = vi.fn<(p: string) => Promise<void>>();
		const removeMirror = vi.fn<(p: string) => Promise<void>>();
		const step = makeLegacyCleanupStep(
			mkPorts(EMPTY, {
				detect,
				removeCloneApp: removeClone,
				removeLaunchdPlist: removePlist,
				removeMirrorStore: removeMirror,
			}),
			{ purgeLegacy: false, assumeYes: true },
		);
		const result = await step.install(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("--purge-legacy");
		expect(detect).not.toHaveBeenCalled();
		expect(removeClone).not.toHaveBeenCalled();
		expect(removePlist).not.toHaveBeenCalled();
		expect(removeMirror).not.toHaveBeenCalled();
	});

	it("detects and cleans when purgeLegacy=true + assumeYes=true", async () => {
		const detected: LegacyArtifacts = {
			cloneApps: ["/Applications/Claude Account Foo.app"],
			launchdPlists: ["/Users/x/Library/LaunchAgents/com.user.claude-sessions-sync.plist"],
			legacyCli: "/usr/local/bin/claude-multiacct",
			mirrorStores: ["/Users/x/Library/Application Support/Claude-foo"],
			legacyDataDir: "/Users/x/.claude-multiacct",
		};
		const prompt = vi.fn<(s: string) => Promise<boolean>>(() => Promise.resolve(true));
		const removeClone = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removePlist = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removeCli = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removeMirror = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const removeData = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const step = makeLegacyCleanupStep(
			mkPorts(detected, {
				promptConfirm: prompt,
				removeCloneApp: removeClone,
				removeLaunchdPlist: removePlist,
				removeLegacyCli: removeCli,
				removeMirrorStore: removeMirror,
				removeLegacyDataDir: removeData,
			}),
			{ purgeLegacy: true, assumeYes: true },
		);
		const result = await step.install(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toMatch(/removed 5 artifact\(s\), 0 failed/u);
		expect(prompt).not.toHaveBeenCalled();
		expect(removeClone).toHaveBeenCalledWith("/Applications/Claude Account Foo.app");
		expect(removePlist).toHaveBeenCalledOnce();
		expect(removeCli).toHaveBeenCalledOnce();
		expect(removeMirror).toHaveBeenCalledOnce();
		expect(removeData).toHaveBeenCalledOnce();
	});

	it("prompts when purgeLegacy=true + assumeYes=false and honors user decline", async () => {
		const detected: LegacyArtifacts = {
			cloneApps: ["/Applications/Claude Account Bar.app"],
			launchdPlists: [],
			legacyCli: undefined,
			mirrorStores: [],
			legacyDataDir: undefined,
		};
		const prompt = vi.fn<(s: string) => Promise<boolean>>(() => Promise.resolve(false));
		const removeClone = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
		const step = makeLegacyCleanupStep(
			mkPorts(detected, { promptConfirm: prompt, removeCloneApp: removeClone }),
			{ purgeLegacy: true, assumeYes: false },
		);
		const result = await step.install(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("user declined");
		expect(prompt).toHaveBeenCalledOnce();
		expect(removeClone).not.toHaveBeenCalled();
	});

	it("does not abort the install when detect() throws", async () => {
		const warn = vi.fn<(m: string) => void>();
		const detect = vi.fn<() => Promise<LegacyArtifacts>>(() =>
			Promise.reject(new Error("readdir EPERM")),
		);
		const step = makeLegacyCleanupStep(
			mkPorts(EMPTY, {
				detect,
				logger: { log: vi.fn<(m: string) => void>(), warn },
			}),
			{ purgeLegacy: true, assumeYes: true },
		);
		const result = await step.install(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toMatch(/cleanup errored/u);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("returns ok=true even when some removals fail (best-effort)", async () => {
		const detected: LegacyArtifacts = {
			cloneApps: ["/Applications/Claude Account A.app", "/Applications/Claude Account B.app"],
			launchdPlists: [],
			legacyCli: undefined,
			mirrorStores: [],
			legacyDataDir: undefined,
		};
		const removeClone = vi
			.fn<(p: string) => Promise<void>>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("EACCES"));
		const step = makeLegacyCleanupStep(mkPorts(detected, { removeCloneApp: removeClone }), {
			purgeLegacy: true,
			assumeYes: true,
		});
		const result = await step.install(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toMatch(/removed 1 artifact\(s\), 1 failed/u);
	});

	it("uninstall is a no-op", async () => {
		const detect = vi.fn<() => Promise<LegacyArtifacts>>(() => Promise.resolve(EMPTY));
		const step = makeLegacyCleanupStep(mkPorts(EMPTY, { detect }), {
			purgeLegacy: true,
			assumeYes: true,
		});
		const result = await step.uninstall(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("no-op");
		expect(detect).not.toHaveBeenCalled();
	});
});
