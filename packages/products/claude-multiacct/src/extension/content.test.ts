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
const ACCOUNTS = [{ uuid: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", label: "A" }];

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
				json: () =>
					Promise.resolve({ ok: true, accounts: ACCOUNTS, activeUuid: ACCOUNTS[0]?.uuid }),
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
		// The runtime-active account from /accounts flows through to the picker:
		// its row mounts pre-selected and the button reflects it, not a bare hint.
		expect(env.doc.querySelector('[data-cma-picker-menu] [data-selected="true"]')).not.toBeNull();
		expect(env.doc.querySelector<HTMLElement>("[data-cma-picker]")?.textContent).toBe("A");
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

	it("mounts when Claude hydrates the anchor in place (attribute added to existing node)", async () => {
		// Intent: Claude's SPA hydrates its top-bar model selector by SETTING
		// data-testid / aria-label on an already-mounted placeholder rather than
		// by inserting a fresh node. A childList-only observer never fires on
		// that mutation, so the picker never appears — exactly the observed
		// prod symptom. Adversarial: revert the observer to
		// `{ childList: true, subtree: true }` and this test goes red.
		const container = env.doc.createElement("div");
		const anchor = env.doc.createElement("button");
		// Element exists at boot but doesn't yet match any findAnchor selector.
		container.append(anchor);
		env.doc.body.append(container);
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		expect(env.doc.querySelector("[data-cma-picker]")).toBeNull();
		// SPA hydration: attribute mutation on the existing node.
		anchor.dataset.testid = "model-selector";
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(env.doc.querySelector("[data-cma-picker]")).not.toBeNull();
		handle?.destroy();
	});

	it("sets the [data-cma-content] diagnostic marker on execution", async () => {
		// Intent: the marker is the operator's single signal that content.js
		// reached execution — without it a matches / injection failure is
		// indistinguishable from a picker-render failure. Adversarial: drop
		// the setAttribute at the top of bootContent and this goes red.
		expect(env.doc.documentElement.dataset.cmaContent).toBeUndefined();
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
		});
		expect(env.doc.documentElement.dataset.cmaContent).toBe("loaded");
		handle?.destroy();
	});

	it("mounts by matching model-family text content when no attribute selector hits (live prod DOM)", async () => {
		// Intent: Claude's real model-selector button has no `data-testid`,
		// no `aria-label`, no `role="combobox"`, and a dynamic base-ui id —
		// none of ANCHOR_SELECTORS match. Live-diagnosed on 2026-07-21: the
		// button is identifiable only by its text content (`Opus 4.7`,
		// `Sonnet 4.5`, `Haiku 4.5`, …). Adversarial: delete the text-content
		// fallback in findAnchor and this goes RED because the anchor never
		// resolves and the picker never mounts.
		const container = env.doc.createElement("div");
		const anchor = env.doc.createElement("button");
		anchor.textContent = "Opus 4.7";
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

	it("text-content fallback matches Sonnet + Haiku too, not just Opus", async () => {
		for (const label of ["Sonnet 4.5", "Haiku 4.5"]) {
			env.doc.body.innerHTML = "";
			const container = env.doc.createElement("div");
			const anchor = env.doc.createElement("button");
			anchor.textContent = label;
			container.append(anchor);
			env.doc.body.append(container);
			// eslint-disable-next-line no-await-in-loop -- sequential per label to keep env fresh
			const handle = await bootContent({
				doc: env.doc,
				win: env.win,
				fetchImpl: makeFetch() as any,
				extensionUrl: (p) => `chrome-extension://x/${p}`,
			});
			expect(env.doc.querySelector("[data-cma-picker]")).not.toBeNull();
			handle?.destroy();
		}
	});

	it("text-content fallback does NOT match a generic button (e.g. a nav Home link)", async () => {
		// Adversarial: if the fallback matched any button, the picker would
		// mount on the wrong anchor. Sanity gate that it's regex-scoped.
		const container = env.doc.createElement("div");
		const btn1 = env.doc.createElement("button");
		btn1.textContent = "Home";
		const btn2 = env.doc.createElement("button");
		btn2.textContent = "New chat";
		container.append(btn1, btn2);
		env.doc.body.append(container);
		const handle = await bootContent({
			doc: env.doc,
			win: env.win,
			fetchImpl: makeFetch() as any,
			extensionUrl: (p) => `chrome-extension://x/${p}`,
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
