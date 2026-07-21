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
	{ uuid: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", label: "icloud", isPrimary: true },
	{ uuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", label: "gmail", isPrimary: false },
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
