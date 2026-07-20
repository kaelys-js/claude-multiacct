/**
 * Intent: usage polling MUST pause while the tab is hidden — a chatty
 * poll from a backgrounded tab would burn the account's quota on
 * telemetry rather than user work. Adversarial: remove the visibility
 * gate and the "stops polling when hidden" test flips red.
 */

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient, BridgeResult } from "./bridge-client.ts";
import { mountUsage } from "./usage.ts";

type GetFn = (path: string) => Promise<BridgeResult<unknown>>;
type PostFn = (path: string, body: unknown) => Promise<BridgeResult<unknown>>;
type SetIntervalFn = (fn: () => void, ms: number) => number;
type ClearIntervalFn = (handle: number) => void;

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

function mkDom(visibilityState: "visible" | "hidden" = "visible"): {
	doc: Document;
	body: HTMLElement;
} {
	const dom = new JSDOM("<!doctype html><html><body></body></html>");
	Object.defineProperty(dom.window.document, "visibilityState", {
		configurable: true,
		get: () => visibilityState,
	});
	return { doc: dom.window.document, body: dom.window.document.body };
}

function client(payload: unknown, ok = true): BridgeClient {
	return {
		get: vi.fn<GetFn>(() =>
			ok
				? Promise.resolve({ ok: true, data: payload })
				: Promise.resolve({ ok: false, kind: "network", detail: "x" }),
		),
		post: vi.fn<PostFn>(),
	} as unknown as BridgeClient;
}

describe("mountUsage", () => {
	let doc: Document;
	let body: HTMLElement;
	beforeEach(() => {
		({ doc, body } = mkDom());
	});

	it("renders subscription + tier + percentage + relative reset", async () => {
		const future = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
		const c = client({
			ok: true,
			verify: { subscription: "Pro", tier: "T1", remainingRatio: 0.42, resetAt: future },
		});
		mountUsage({ host: body, client: c, accountUuid: ACCOUNT, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		const pill = body.querySelector<HTMLElement>("[data-cma-usage]");
		expect(pill?.textContent).toContain("Pro");
		expect(pill?.textContent).toContain("T1");
		expect(pill?.textContent).toContain("42%");
		expect(pill?.textContent).toMatch(/resets 2h/u);
	});

	it("renders — when remainingRatio is 'unknown' (no NaN or 0)", async () => {
		const c = client({
			ok: true,
			verify: { subscription: "S", tier: "T", remainingRatio: "unknown", resetAt: "" },
		});
		mountUsage({ host: body, client: c, accountUuid: ACCOUNT, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		const pill = body.querySelector<HTMLElement>("[data-cma-usage]");
		expect(pill?.textContent).toContain("—");
		expect(pill?.textContent).not.toContain("NaN");
	});

	it("renders — when the fetch failed (no verify payload)", async () => {
		const c = client(undefined, false);
		mountUsage({ host: body, client: c, accountUuid: ACCOUNT, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(body.querySelector<HTMLElement>("[data-cma-usage]")?.textContent).toBe("—");
	});

	it("does NOT start polling when the tab boots hidden", () => {
		({ doc, body } = mkDom("hidden"));
		const setIv = vi.fn<SetIntervalFn>(() => 42);
		const clearIv = vi.fn<ClearIntervalFn>();
		const c = client({
			ok: true,
			verify: { subscription: "P", tier: "T", remainingRatio: 1, resetAt: "" },
		});
		mountUsage({
			host: body,
			client: c,
			accountUuid: ACCOUNT,
			doc,
			intervalMs: 10,
			setInterval: setIv,
			clearInterval: clearIv,
		});
		expect(setIv).not.toHaveBeenCalled();
		// And no initial fetch on hidden boot.
		expect((c.get as any).mock.calls.length).toBe(0);
	});

	it("visibilitychange to hidden clears the interval; back to visible starts it again", () => {
		const setIv = vi.fn<SetIntervalFn>((_fn, _ms) => 7);
		const clearIv = vi.fn<ClearIntervalFn>();
		const c = client({
			ok: true,
			verify: { subscription: "P", tier: "T", remainingRatio: 1, resetAt: "" },
		});
		mountUsage({
			host: body,
			client: c,
			accountUuid: ACCOUNT,
			doc,
			intervalMs: 10,
			setInterval: setIv,
			clearInterval: clearIv,
		});
		expect(setIv).toHaveBeenCalledTimes(1);

		// Flip to hidden.
		Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "hidden" });
		doc.dispatchEvent(new doc.defaultView!.Event("visibilitychange"));
		expect(clearIv).toHaveBeenCalledWith(7);

		// Back to visible.
		Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "visible" });
		doc.dispatchEvent(new doc.defaultView!.Event("visibilitychange"));
		expect(setIv).toHaveBeenCalledTimes(2);
	});

	it("destroy() clears the interval, removes the visibility listener, and drops the pill", () => {
		const setIv = vi.fn<SetIntervalFn>(() => 9);
		const clearIv = vi.fn<ClearIntervalFn>();
		const c = client({
			ok: true,
			verify: { subscription: "P", tier: "T", remainingRatio: 1, resetAt: "" },
		});
		const handle = mountUsage({
			host: body,
			client: c,
			accountUuid: ACCOUNT,
			doc,
			setInterval: setIv,
			clearInterval: clearIv,
		});
		handle.destroy();
		expect(clearIv).toHaveBeenCalledWith(9);
		expect(body.querySelector("[data-cma-usage]")).toBeNull();
	});

	it("relative-time renders m/h/d/now (dur-format sanity)", async () => {
		for (const [deltaMs, expected] of [
			[-1000, "now"],
			[15 * 60 * 1000, "15m"],
			[3 * 3600 * 1000, "3h"],
			[2 * 86_400 * 1000, "2d"],
		] as const) {
			({ doc, body } = mkDom());
			const c = client({
				ok: true,
				verify: {
					subscription: "S",
					tier: "T",
					remainingRatio: 1,
					resetAt: new Date(Date.now() + deltaMs).toISOString(),
				},
			});
			mountUsage({ host: body, client: c, accountUuid: ACCOUNT, doc });
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			});
			const pill = body.querySelector<HTMLElement>("[data-cma-usage]");
			expect(pill?.textContent).toContain(expected);
		}
	});

	it("renders without a resetAt (empty relative-time doesn't dangle 'resets ')", async () => {
		const c = client({
			ok: true,
			verify: { subscription: "S", tier: "T", remainingRatio: 0.5, resetAt: undefined },
		});
		mountUsage({ host: body, client: c, accountUuid: ACCOUNT, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		const pill = body.querySelector<HTMLElement>("[data-cma-usage]");
		expect(pill?.textContent).not.toContain("resets");
	});

	it("the poll callback invokes fetchOnce on each tick (covers the setInterval body)", async () => {
		let tickFn: (() => void) | undefined;
		const setIv = vi.fn<SetIntervalFn>((fn, _ms) => {
			tickFn = fn;
			return 33;
		});
		const clearIv = vi.fn<ClearIntervalFn>();
		const c = client({
			ok: true,
			verify: { subscription: "S", tier: "T", remainingRatio: 0.5, resetAt: "" },
		});
		mountUsage({
			host: body,
			client: c,
			accountUuid: ACCOUNT,
			doc,
			setInterval: setIv,
			clearInterval: clearIv,
		});
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(tickFn).toBeDefined();
		const initialCalls = (c.get as any).mock.calls.length;
		tickFn?.();
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect((c.get as any).mock.calls.length).toBe(initialCalls + 1);
	});

	it("startPolling is a no-op when a timer is already active (visibility flip stays idempotent)", () => {
		const setIv = vi.fn<SetIntervalFn>(() => 44);
		const clearIv = vi.fn<ClearIntervalFn>();
		const c = client({
			ok: true,
			verify: { subscription: "S", tier: "T", remainingRatio: 0.5, resetAt: "" },
		});
		mountUsage({
			host: body,
			client: c,
			accountUuid: ACCOUNT,
			doc,
			setInterval: setIv,
			clearInterval: clearIv,
		});
		expect(setIv).toHaveBeenCalledTimes(1);
		// A visible→visible flip must not start a second interval.
		doc.dispatchEvent(new doc.defaultView!.Event("visibilitychange"));
		expect(setIv).toHaveBeenCalledTimes(1);
	});

	it("fetchOnce after destroy() does not render (protects against a late tick)", async () => {
		let tickFn: (() => void) | undefined;
		const setIv = vi.fn<SetIntervalFn>((fn) => {
			tickFn = fn;
			return 1;
		});
		const clearIv = vi.fn<ClearIntervalFn>();
		let resolveGet: ((v: unknown) => void) | undefined;
		const delayed = {
			get: vi.fn<() => Promise<unknown>>(
				() =>
					new Promise((resolve) => {
						resolveGet = resolve;
					}),
			),
			post: vi.fn<PostFn>(),
		} as unknown as BridgeClient;
		const handle = mountUsage({
			host: body,
			client: delayed,
			accountUuid: ACCOUNT,
			doc,
			setInterval: setIv,
			clearInterval: clearIv,
		});
		handle.destroy();
		// Now resolve the pending fetch.
		resolveGet?.({
			ok: true,
			data: { ok: true, verify: { subscription: "S", tier: "T", remainingRatio: 1, resetAt: "" } },
		});
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		// Pill is gone; render on the destroyed instance was skipped.
		expect(body.querySelector("[data-cma-usage]")).toBeNull();
		expect(tickFn).toBeDefined();
	});

	it("swallows an invalid resetAt (NaN parse) without breaking the render", async () => {
		const c = client({
			ok: true,
			verify: { subscription: "S", tier: "T", remainingRatio: 0.5, resetAt: "not-a-date" },
		});
		mountUsage({ host: body, client: c, accountUuid: ACCOUNT, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(body.querySelector<HTMLElement>("[data-cma-usage]")?.textContent).not.toContain("NaN");
	});
});
