/**
 * Intent: `reconcile.ts` carries the two load-bearing contracts for PR3 as a
 * gated PR — (1) with the flag OFF, every dir routes to skip so the watcher
 * runtime performs zero installs (the default-off ship contract), and (2)
 * on a post-install state, `reconcile` produces zero installs, so launchd
 * re-firing the agent on unrelated writes is safe. The flag-off case is the
 * adversarial one: mutate `reconcile` to ignore `opts.flag` and this test
 * goes red immediately.
 */

import { describe, expect, it } from "vitest";
import { reconcile } from "./reconcile.ts";
import type { DirState } from "./scan.ts";

const uninstalled = (path: string): DirState => ({ path, version: "1.2.3", kind: "uninstalled" });
const installed = (path: string): DirState => ({ path, version: "1.2.3", kind: "installed" });
const other = (path: string, reason: string): DirState => ({
	path,
	version: "1.2.3",
	kind: "other",
	reason,
});

describe("reconcile — flag OFF (default-off contract)", () => {
	it("every dir → skip with reason 'flag-off' (adversarial: mutate reconcile to ignore the flag and this goes red)", () => {
		const states: DirState[] = [uninstalled("/a"), installed("/b"), other("/c", "missing-claude")];
		const actions = reconcile(states, { flag: false });
		expect(actions.install).toStrictEqual([]);
		expect(actions.uninstall).toStrictEqual([]);
		expect(actions.skip).toStrictEqual([
			{ path: "/a", reason: "flag-off" },
			{ path: "/b", reason: "flag-off" },
			{ path: "/c", reason: "flag-off" },
		]);
	});

	it("empty states + flag off → empty actions", () => {
		expect(reconcile([], { flag: false })).toStrictEqual({ install: [], uninstall: [], skip: [] });
	});
});

describe("reconcile — flag ON", () => {
	it("uninstalled → install", () => {
		expect(reconcile([uninstalled("/a")], { flag: true }).install).toStrictEqual(["/a"]);
	});

	it("installed → skip 'already-installed'", () => {
		expect(reconcile([installed("/a")], { flag: true }).skip).toStrictEqual([
			{ path: "/a", reason: "already-installed" },
		]);
	});

	it("other → skip with the underlying reason", () => {
		expect(reconcile([other("/a", "missing-claude")], { flag: true }).skip).toStrictEqual([
			{ path: "/a", reason: "missing-claude" },
		]);
	});

	it("other with no reason → skip 'other' (defensive fallback)", () => {
		const s: DirState = { path: "/a", version: "1.2.3", kind: "other" };
		expect(reconcile([s], { flag: true }).skip).toStrictEqual([{ path: "/a", reason: "other" }]);
	});

	it("idempotent by construction: post-install state (all installed) → zero installs, all skip", () => {
		// This is what makes launchd re-firing safe: the second pass is a no-op.
		const post: DirState[] = [installed("/a"), installed("/b"), installed("/c")];
		const actions = reconcile(post, { flag: true });
		expect(actions.install).toStrictEqual([]);
		expect(actions.skip.map((s) => s.reason)).toStrictEqual([
			"already-installed",
			"already-installed",
			"already-installed",
		]);
	});
});
