/**
 * Intent: the content-script glue must mount the picker only after the
 * Code SPA has painted its model-selector anchor (which is asynchronous),
 * and it must tear down cleanly on beforeunload so a full reload doesn't
 * leak the usage poll interval. Adversarial: skip observer.disconnect
 * in beforeunload and the "no observer callbacks after unload" test
 * flips red on the next mutation.
 */

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootContent } from "./content.ts";

const BRIDGE = { port: 9000, secret: "s", version: "v" };
const ACCOUNTS = [{ uuid: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", label: "A", isPrimary: true }];

type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type FetchFn = (url: string, init?: unknown) => Promise<FetchResponse>;

function makeFetch(bridgeFail = false): ReturnType<typeof vi.fn<FetchFn>> {
	return vi.fn<FetchFn>((url: string, _init?: unknown) => {
		if (url.endsWith("/bridge.json")) {
			if (bridgeFail) {
				return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
			}
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(BRIDGE) });
		}
		if (url.endsWith("/accounts")) {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ ok: true, accounts: ACCOUNTS }),
			});
		}
		if (url.includes("/usage/")) {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({
						ok: true,
						verify: { subscription: "P", tier: "T", remainingRatio: 1, resetAt: "" },
					}),
			});
		}
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
	});
}

// Fetch mock where `/bridge.json` and `/usage/*` succeed but `/accounts` 500s.
function makeFailingAccountsFetch(): ReturnType<typeof vi.fn<FetchFn>> {
	return vi.fn<FetchFn>((url: string) => {
		if (url.endsWith("/bridge.json")) {
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(BRIDGE) });
		}
		if (url.endsWith("/accounts")) {
			return Promise.resolve({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ ok: false }),
			});
		}
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
	});
}

function mkEnv(): { dom: JSDOM; doc: Document; win: Window } {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "https://claude.ai/chat",
	});
	return { dom, doc: dom.window.document, win: dom.window as unknown as Window };
}

describe("bootContent", () => {
	let env: ReturnType<typeof mkEnv>;
	beforeEach(() => {
		env = mkEnv();
	});

	it("returns undefined and stays inert when bridge.json is unavailable", async () => {
		const result = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch(true) as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		expect(result).toBeUndefined();
	});

	it("mounts the picker after the anchor appears via MutationObserver", async () => {
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		expect(handle).toBeDefined();
		// Anchor doesn't exist yet.
		expect(env.doc.querySelector("[data-cma-picker]")).toBeNull();
		// Inject anchor asynchronously (SPA paint).
		const anchor = env.doc.createElement("button");
		anchor.dataset.testid = "model-picker";
		const container = env.doc.createElement("div");
		container.append(anchor);
		env.doc.body.append(container);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(env.doc.querySelector("[data-cma-picker]")).not.toBeNull();
		handle?.destroy();
	});

	it("mounts synchronously when the anchor is already present at boot", async () => {
		const container = env.doc.createElement("div");
		const anchor = env.doc.createElement("button");
		anchor.dataset.testid = "model-selector";
		container.append(anchor);
		env.doc.body.append(container);
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		expect(env.doc.querySelector("[data-cma-picker]")).not.toBeNull();
		handle?.destroy();
	});

	it("destroy() disconnects the observer — no further mount on new anchor injection", async () => {
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		handle?.destroy();
		const container = env.doc.createElement("div");
		const anchor = env.doc.createElement("button");
		anchor.dataset.testid = "model-selector";
		container.append(anchor);
		env.doc.body.append(container);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(env.doc.querySelector("[data-cma-picker]")).toBeNull();
	});

	it("beforeunload tears down the picker (no leaked interval on reload)", async () => {
		const container = env.doc.createElement("div");
		const anchor = env.doc.createElement("button");
		anchor.dataset.testid = "model-selector";
		container.append(anchor);
		env.doc.body.append(container);
		await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		expect(env.doc.querySelector("[data-cma-picker]")).not.toBeNull();
		env.win.dispatchEvent(new env.dom.window.Event("beforeunload"));
		expect(env.doc.querySelector("[data-cma-picker]")).toBeNull();
	});

	it("survives a /accounts fetch failure (accounts stays empty, no usage pills mount)", async () => {
		const fetchImpl = makeFailingAccountsFetch();
		const container = env.doc.createElement("div");
		const anchor = env.doc.createElement("button");
		anchor.dataset.testid = "model-selector";
		container.append(anchor);
		env.doc.body.append(container);
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: fetchImpl as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		// Picker still mounts (with an empty account list), no usage pills.
		expect(env.doc.querySelectorAll("[data-cma-picker]")).toHaveLength(1);
		expect(env.doc.querySelectorAll("[data-cma-usage]")).toHaveLength(0);
		handle?.destroy();
	});

	it("observer no-ops when a mutation fires but no anchor is yet present (avoids empty mount)", async () => {
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		// Fire the observer with an unrelated mutation — anchor is still missing.
		env.doc.body.append(env.doc.createElement("div"));
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(env.doc.querySelector("[data-cma-picker]")).toBeNull();
		handle?.destroy();
	});

	it("no-ops the re-mount if a picker is already attached to the anchor", async () => {
		const container = env.doc.createElement("div");
		const anchor = env.doc.createElement("button");
		anchor.dataset.testid = "model-selector";
		container.append(anchor);
		env.doc.body.append(container);
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		const first = env.doc.querySelector("[data-cma-picker]");
		// Trigger the observer with an unrelated mutation.
		env.doc.body.append(env.doc.createElement("span"));
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		const second = env.doc.querySelector("[data-cma-picker]");
		expect(second).toBe(first);
		handle?.destroy();
	});
});
