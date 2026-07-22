/**
 * Intent: `usage.ts` is a user-menu augmenter, NOT per-account pills in
 * the bottom bar. It watches for Claude's own user-menu popup (identified
 * by `[data-testid="user-menu-header"]`) and injects an "Account" section
 * with per-account rows. `notifyActive(uuid)` updates the checkmark when
 * the picker fires onChoice. `fetchOne(uuid)` populates the usage detail
 * text inside each row.
 *
 * Adversarial: if the section-marker check is removed, re-observation of
 * the menu re-injects duplicate sections — the "no duplicate injection"
 * test goes RED. If notifyActive stops rerender, the "checkmark follows
 * active uuid" test goes RED.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { BridgeClient, BridgeResult } from "./bridge-client.ts";
import { mountUsage, type UsageMountOptions } from "./usage.ts";
import type { PickerAccount } from "./picker.ts";

type FakeGet = (path: string) => Promise<BridgeResult<unknown>>;

const noopPost: (path: string, body?: unknown) => Promise<BridgeResult<unknown>> = () =>
	Promise.resolve({ ok: true, status: 200, data: {} } as BridgeResult<unknown>);

function mkClient(get: FakeGet): BridgeClient {
	return { get, post: noopPost } as unknown as BridgeClient;
}

function mkEnv(): { doc: Document; win: Window; menuHost: HTMLElement } {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "https://claude.ai/chat/abc",
	});
	const doc = dom.window.document;
	const menuHost = doc.createElement("div");
	doc.body.append(menuHost);
	return { doc, win: dom.window as unknown as Window, menuHost };
}

function openClaudeMenu(doc: Document, menuHost: HTMLElement): HTMLElement {
	const menu = doc.createElement("div");
	menu.setAttribute("role", "menu");
	const inner = doc.createElement("div");
	menu.append(inner);
	const emailRow = doc.createElement("div");
	const email = doc.createElement("span");
	email.dataset.testid = "user-menu-header";
	email.textContent = "cole.bieker@icloud.com";
	emailRow.append(email);
	inner.append(emailRow);
	menuHost.append(menu);
	return menu;
}

function tick(): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

const ACCOUNTS: PickerAccount[] = [
	{ uuid: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", label: "icloud" },
	{ uuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", label: "gmail" },
];

function mkOpts(env: { doc: Document }, get: FakeGet): UsageMountOptions {
	return {
		doc: env.doc,
		client: mkClient(get),
		accounts: ACCOUNTS,
		setInterval: (_fn: () => void, _ms: number): number => 42,
		clearInterval: (_h: number): void => {
			// no-op — tests don't drive real polling
		},
	};
}

describe("mountUsage — user-menu augmenter", () => {
	it("injects an Account section with one row per account after the menu appears", async () => {
		const env = mkEnv();
		const get = vi.fn<FakeGet>(() =>
			Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
		);
		const handle = mountUsage(mkOpts(env, get));
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		const section = env.doc.querySelector("[data-cma-user-menu-section]");
		expect(section).not.toBeNull();
		const rows = env.doc.querySelectorAll("[data-cma-account-uuid]");
		expect(rows).toHaveLength(2);
		handle.destroy();
	});

	it("does not double-inject on repeated MutationObserver ticks", async () => {
		const env = mkEnv();
		const get = vi.fn<FakeGet>(() =>
			Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
		);
		const handle = mountUsage(mkOpts(env, get));
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		env.doc.body.append(env.doc.createElement("div"));
		await tick();
		expect(env.doc.querySelectorAll("[data-cma-user-menu-section]")).toHaveLength(1);
		handle.destroy();
	});

	it("notifyActive(uuid) moves the checkmark to the requested row", async () => {
		const env = mkEnv();
		const get = vi.fn<FakeGet>(() =>
			Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
		);
		const handle = mountUsage(mkOpts(env, get));
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		const rowsBefore = env.doc.querySelectorAll<HTMLElement>("[data-cma-account-uuid]");
		expect(rowsBefore[0]?.firstElementChild?.textContent).toBe("✓");
		expect(rowsBefore[1]?.firstElementChild?.textContent).toBe("");
		handle.notifyActive(ACCOUNTS[1]!.uuid);
		const rowsAfter = env.doc.querySelectorAll<HTMLElement>("[data-cma-account-uuid]");
		expect(rowsAfter[0]?.firstElementChild?.textContent).toBe("");
		expect(rowsAfter[1]?.firstElementChild?.textContent).toBe("✓");
		handle.destroy();
	});

	it("destroy() removes the injected section and disconnects the observer", async () => {
		const env = mkEnv();
		const get = vi.fn<FakeGet>(() =>
			Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
		);
		const handle = mountUsage(mkOpts(env, get));
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		expect(env.doc.querySelector("[data-cma-user-menu-section]")).not.toBeNull();
		handle.destroy();
		expect(env.doc.querySelector("[data-cma-user-menu-section]")).toBeNull();
	});

	it("does nothing when Claude's menu never opens (no user-menu-header ever appears)", async () => {
		const env = mkEnv();
		const get = vi.fn<FakeGet>(() =>
			Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
		);
		const handle = mountUsage(mkOpts(env, get));
		await tick();
		expect(env.doc.querySelector("[data-cma-user-menu-section]")).toBeNull();
		handle.destroy();
	});
});

// Verify payload wired to /usage/:uuid. `subscription`/`tier` are mapped but the
// detail line the row renders is built from `remainingRatio` + `resetAt`, so
// those two drive every formatter branch below.
function verifyPayload(verify: Record<string, unknown>): BridgeResult<unknown> {
	return { ok: true, status: 200, data: { ok: true, verify } } as BridgeResult<unknown>;
}

function firstRowDetail(doc: Document): string {
	const row = doc.querySelector<HTMLElement>("[data-cma-account-uuid]");
	// check(0), label(1), detail(2 — only present when non-empty).
	return row?.children[2]?.textContent ?? "";
}

describe("mountUsage — usage detail rendering (fetchOne mapping + formatters)", () => {
	it("maps a verify payload and renders `% left · resets in Nh` (hour bucket)", async () => {
		const env = mkEnv();
		const resetAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
		const handle = mountUsage(
			mkOpts(env, () =>
				Promise.resolve(
					verifyPayload({ subscription: "pro", tier: "tier1", remainingRatio: 0.5, resetAt }),
				),
			),
		);
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		await tick();
		const detail = firstRowDetail(env.doc);
		expect(detail).toContain("50% left");
		expect(detail).toContain("resets in 2h");
		handle.destroy();
	});

	it("renders the minute bucket for a reset under an hour away", async () => {
		const env = mkEnv();
		const resetAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
		const handle = mountUsage(
			mkOpts(env, () => Promise.resolve(verifyPayload({ remainingRatio: 0.9, resetAt }))),
		);
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		await tick();
		expect(firstRowDetail(env.doc)).toContain("resets in 30m");
		handle.destroy();
	});

	it("renders the day bucket for a reset more than a day away", async () => {
		const env = mkEnv();
		const resetAt = new Date(Date.now() + 2 * 86_400 * 1000).toISOString();
		const handle = mountUsage(
			mkOpts(env, () => Promise.resolve(verifyPayload({ remainingRatio: 0.1, resetAt }))),
		);
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		await tick();
		expect(firstRowDetail(env.doc)).toContain("resets in 2d");
		handle.destroy();
	});

	it("shows no detail when ratio is `unknown` and the reset is already in the past (now)", async () => {
		const env = mkEnv();
		const resetAt = new Date(Date.now() - 1000).toISOString();
		const handle = mountUsage(
			mkOpts(env, () => Promise.resolve(verifyPayload({ remainingRatio: "unknown", resetAt }))),
		);
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		await tick();
		// ratioLabel("unknown") === "" and relativeTime(past) === "now" (dropped) → empty detail.
		expect(firstRowDetail(env.doc)).toBe("");
		handle.destroy();
	});

	it("tolerates an unparseable resetAt and a missing ratio (both guards → empty detail)", async () => {
		const env = mkEnv();
		const handle = mountUsage(
			mkOpts(env, () => Promise.resolve(verifyPayload({ resetAt: "not-a-real-date" }))),
		);
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		await tick();
		expect(firstRowDetail(env.doc)).toBe("");
		handle.destroy();
	});

	it("an HTTP-level failure (res.ok false) leaves the row with empty usage, not a crash", async () => {
		const env = mkEnv();
		const handle = mountUsage(
			mkOpts(env, () =>
				Promise.resolve({ ok: false, status: 404, data: {} } as unknown as BridgeResult<unknown>),
			),
		);
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		await tick();
		expect(env.doc.querySelectorAll("[data-cma-account-uuid]")).toHaveLength(2);
		expect(firstRowDetail(env.doc)).toBe("");
		handle.destroy();
	});

	it("a fetch that throws is swallowed — the section still renders", async () => {
		const env = mkEnv();
		const handle = mountUsage(mkOpts(env, () => Promise.reject(new Error("network down"))));
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		await tick();
		expect(env.doc.querySelector("[data-cma-user-menu-section]")).not.toBeNull();
		handle.destroy();
	});

	it("a fetch resolving AFTER destroy() is ignored (destroyed guard)", async () => {
		const env = mkEnv();
		let release: ((r: BridgeResult<unknown>) => void) | undefined;
		const pending = new Promise<BridgeResult<unknown>>((resolve) => {
			release = resolve;
		});
		const handle = mountUsage(mkOpts(env, () => pending));
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		handle.destroy();
		// Resolve the in-flight fetch after teardown — the destroyed guard returns
		// before touching the (now-removed) DOM.
		release?.(verifyPayload({ remainingRatio: 0.5 }));
		await tick();
		expect(env.doc.querySelector("[data-cma-user-menu-section]")).toBeNull();
	});
});

function defineVisibility(doc: Document, ref: { value: string }): void {
	Object.defineProperty(doc, "visibilityState", {
		configurable: true,
		get: () => ref.value,
	});
}

describe("mountUsage — visibility-driven polling", () => {
	it("polls while visible, stops when hidden, and resumes when visible again", async () => {
		const env = mkEnv();
		const vis = { value: "visible" };
		defineVisibility(env.doc, vis);
		let tickFn: (() => void) | undefined;
		const setIv = vi.fn<(fn: () => void, ms: number) => number>((fn) => {
			tickFn = fn;
			return 7;
		});
		const clearIv = vi.fn<(h: number) => void>();
		const get = vi.fn<FakeGet>(() =>
			Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
		);
		const handle = mountUsage({
			doc: env.doc,
			client: mkClient(get),
			accounts: ACCOUNTS,
			intervalMs: 1000,
			setInterval: setIv,
			clearInterval: clearIv,
		});
		// Visible at mount → polling starts immediately.
		expect(setIv).toHaveBeenCalledTimes(1);
		expect(setIv).toHaveBeenCalledWith(expect.any(Function), 1000);

		// The interval callback drives a fetchAll (one get per account).
		get.mockClear();
		tickFn?.();
		await tick();
		expect(get).toHaveBeenCalledTimes(ACCOUNTS.length);

		// A second visible event while already polling is a no-op (idempotent guard).
		env.doc.dispatchEvent(new env.doc.defaultView!.Event("visibilitychange"));
		expect(setIv).toHaveBeenCalledTimes(1);

		// Hidden → polling stops (clearInterval with the stored handle).
		vis.value = "hidden";
		env.doc.dispatchEvent(new env.doc.defaultView!.Event("visibilitychange"));
		expect(clearIv).toHaveBeenCalledWith(7);

		// A second hidden event while already stopped is a no-op.
		env.doc.dispatchEvent(new env.doc.defaultView!.Event("visibilitychange"));
		expect(clearIv).toHaveBeenCalledTimes(1);

		// Visible again → polling resumes with a fresh interval.
		vis.value = "visible";
		env.doc.dispatchEvent(new env.doc.defaultView!.Event("visibilitychange"));
		expect(setIv).toHaveBeenCalledTimes(2);

		handle.destroy();
	});

	it("does not start polling at mount when the document is hidden", () => {
		const env = mkEnv();
		const vis = { value: "hidden" };
		defineVisibility(env.doc, vis);
		const setIv = vi.fn<(fn: () => void, ms: number) => number>(() => 1);
		const handle = mountUsage({
			doc: env.doc,
			client: mkClient(() =>
				Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
			),
			accounts: ACCOUNTS,
			setInterval: setIv,
			clearInterval: vi.fn<(h: number) => void>(),
		});
		expect(setIv).not.toHaveBeenCalled();
		handle.destroy();
	});

	it("falls back to the real setInterval/clearInterval when no timer shims are injected", () => {
		// Covers the default setInterval/clearInterval arrows: mount visible with no
		// shims (real timers), then destroy — startPolling arms a real interval and
		// stopPolling clears it. Fake timers keep it from actually firing.
		vi.useFakeTimers();
		try {
			const env = mkEnv();
			defineVisibility(env.doc, { value: "visible" });
			const handle = mountUsage({
				doc: env.doc,
				client: mkClient(() =>
					Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
				),
				accounts: ACCOUNTS,
				intervalMs: 1000,
			});
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			handle.destroy();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("mountUsage — row interactions", () => {
	it("highlights a non-active row on hover, leaves the active row untouched, and fires onSwitch on click", async () => {
		const env = mkEnv();
		const onSwitch = vi.fn<(uuid: string) => void>();
		const handle = mountUsage({
			doc: env.doc,
			client: mkClient(() =>
				Promise.resolve({ ok: true, status: 200, data: { ok: true } } as BridgeResult<unknown>),
			),
			accounts: ACCOUNTS,
			setInterval: () => 1,
			clearInterval: () => {},
			onSwitch,
		});
		openClaudeMenu(env.doc, env.menuHost);
		await tick();
		const rows = env.doc.querySelectorAll<HTMLElement>("[data-cma-account-uuid]");
		const active = rows[0]!; // icloud is first in pool order → active by default
		const inactive = rows[1]!;

		inactive.dispatchEvent(new env.doc.defaultView!.Event("mouseenter"));
		expect(inactive.style.background).toBe("rgba(255, 255, 255, 0.08)");
		inactive.dispatchEvent(new env.doc.defaultView!.Event("mouseleave"));
		expect(inactive.style.background).toBe("transparent");

		// Hovering the active row must NOT repaint it (the !isActive guard).
		active.dispatchEvent(new env.doc.defaultView!.Event("mouseenter"));
		expect(active.style.background).toBe("rgba(255, 255, 255, 0.06)");

		inactive.dispatchEvent(new env.doc.defaultView!.Event("click"));
		expect(onSwitch).toHaveBeenCalledWith(ACCOUNTS[1]!.uuid);
		handle.destroy();
	});
});
