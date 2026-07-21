/* eslint-disable vitest/no-conditional-in-test, jsdoc/require-returns, jsdoc/require-param, jsdoc/require-jsdoc */
/**
 * Intent: the install-pipeline `legacy-cleanup` step MUST be a thin wrapper
 * around `runLegacyCleanup`: skip when `flag=false`, honor `assumeYes`,
 * return `ok:true` even when the wrapped run partially fails, and never
 * throw (a detection error must not abort the whole install).
 *
 * Adversarial: remove the `try/catch` around `runLegacyCleanup` and the
 * "detect throws" test flips RED. Change the `flag !== true` gate and the
 * "skips when flag=false" test flips RED.
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
		const step = makeLegacyCleanupStep(mkPorts(), { assumeYes: true });
		expect(step.name).toBe("legacy-cleanup");
	});

	it("skips work when flag is false", async () => {
		const detect = vi.fn<() => Promise<LegacyArtifacts>>(() => Promise.resolve(EMPTY));
		const step = makeLegacyCleanupStep(mkPorts(EMPTY, { detect }), { assumeYes: true });
		const result = await step.install(false);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("skipped");
		expect(detect).not.toHaveBeenCalled();
	});

	it("detects and cleans when flag=true; passes assumeYes through", async () => {
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
			{ assumeYes: true },
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

	it("prompts when assumeYes=false and honors user decline", async () => {
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
			{ assumeYes: false },
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
			{ assumeYes: true },
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
			assumeYes: true,
		});
		const result = await step.install(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toMatch(/removed 1 artifact\(s\), 1 failed/u);
	});

	it("uninstall is a no-op", async () => {
		const detect = vi.fn<() => Promise<LegacyArtifacts>>(() => Promise.resolve(EMPTY));
		const step = makeLegacyCleanupStep(mkPorts(EMPTY, { detect }), { assumeYes: true });
		const result = await step.uninstall(true);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("no-op");
		expect(detect).not.toHaveBeenCalled();
	});
});
