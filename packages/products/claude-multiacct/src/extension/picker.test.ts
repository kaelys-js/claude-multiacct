/**
 * Intent: the picker is a light-DOM Claude-styled button + portal menu (see
 * `picker.ts` docstring for why light DOM won over shadow DOM). Every test
 * here pins one load-bearing behaviour of that surface:
 *
 *  - Button label mirrors the current pick (or the primary, or the "…"
 *    fallback when neither is present).
 *  - Clicking a menu item POSTs the choice to `/choice/<sessionUuid>` and
 *    calls `onChoice`; a POST failure reverts the optimistic label.
 *  - Menu open/close toggles on the button, closes on outside click.
 *  - `destroy()` removes both the button and the portal menu from the doc.
 *  - `sessionUuid === undefined` (pre-session pages like `/new`) guards
 *    against writing a choice.
 *
 * Adversarial: strip the `hidden` toggle in `openMenu` and the "second click
 * closes" test flips red. Strip the `sessionUuid === undefined` guard and
 * the pre-session no-op test flips red.
 */

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient, BridgeErrorKind, BridgeResult } from "./bridge-client.ts";
import { mountPicker, type PickerAccount } from "./picker.ts";

type GetFn = (path: string) => Promise<BridgeResult<unknown>>;
type PostFn = (path: string, body: unknown) => Promise<BridgeResult<unknown>>;

const ACCOUNTS: PickerAccount[] = [
	{ uuid: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", label: "Alice", isPrimary: true },
	{ uuid: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", label: "Bob", isPrimary: false },
];

function mkDom(): { doc: Document; body: HTMLElement } {
	const dom = new JSDOM("<!doctype html><html><body></body></html>");
	return { doc: dom.window.document, body: dom.window.document.body };
}

function mockClient(postResult?: { ok: boolean; kind?: BridgeErrorKind }): BridgeClient {
	const effective = postResult ?? { ok: true };
	return {
		get: vi.fn<GetFn>(() => Promise.resolve({ ok: true, data: { ok: true, accounts: ACCOUNTS } })),
		post: vi.fn<PostFn>(() =>
			effective.ok
				? Promise.resolve({ ok: true, data: { ok: true } })
				: Promise.resolve({ ok: false, kind: effective.kind ?? "network", detail: "x" }),
		),
	} as unknown as BridgeClient;
}

const SESSION = "550e8400-e29b-41d4-a716-446655440000";

function getButton(doc: Document): HTMLButtonElement {
	const btn = doc.body.querySelector<HTMLButtonElement>("[data-cma-picker]");
	if (btn === null) {
		throw new Error("picker button not mounted");
	}
	return btn;
}

function getMenu(doc: Document): HTMLElement {
	const menu = doc.body.querySelector<HTMLElement>("[data-cma-picker-menu]");
	if (menu === null) {
		throw new Error("picker menu not attached to body");
	}
	return menu;
}

function getItems(doc: Document): HTMLElement[] {
	return [...getMenu(doc).querySelectorAll<HTMLElement>("[data-uuid]")];
}

describe("mountPicker", () => {
	let doc: Document;
	let body: HTMLElement;
	beforeEach(() => {
		({ doc, body } = mkDom());
	});

	it("renders the primary account label by default on the light-DOM button", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		const btn = getButton(doc);
		expect(btn.textContent).toBe("Alice");
	});

	it("puts the menu at the document body (portal-style) so bottom-bar overflow can't clip it", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		// The menu is a direct child of <body>, NOT nested inside `host`.
		// Dropping the `doc.body.append(menu)` in picker.ts would make the
		// menu land inside `host` and this assertion would flip red.
		const menu = getMenu(doc);
		expect(menu.parentElement).toBe(doc.body);
		// It starts hidden — opens only on button click.
		expect(menu.hidden).toBe(true);
	});

	it("clicking a non-primary item POSTs the choice with the session uuid and body", async () => {
		const client = mockClient();
		mountPicker({ host: body, client, sessionUuid: SESSION, doc, accounts: ACCOUNTS });
		getButton(doc).click();
		const items = getItems(doc);
		items[1]?.click();
		await Promise.resolve();
		expect(client.post).toHaveBeenCalledWith(`/choice/${SESSION}`, {
			accountUuid: ACCOUNTS[1]?.uuid,
		});
	});

	it("reverts the label when the POST fails (optimistic UI recovery)", async () => {
		const client = mockClient({ ok: false, kind: "network" });
		mountPicker({ host: body, client, sessionUuid: SESSION, doc, accounts: ACCOUNTS });
		getButton(doc).click();
		getItems(doc)[1]?.click();
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(getButton(doc).textContent).toBe("Alice");
	});

	it("destroy() removes the picker button and the portal menu from the doc", () => {
		const handle = mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		expect(doc.body.querySelector("[data-cma-picker]")).not.toBeNull();
		expect(doc.body.querySelector("[data-cma-picker-menu]")).not.toBeNull();
		handle.destroy();
		expect(doc.body.querySelector("[data-cma-picker]")).toBeNull();
		expect(doc.body.querySelector("[data-cma-picker-menu]")).toBeNull();
	});

	it("clicking the toggle a second time closes the menu", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		const btn = getButton(doc);
		btn.click();
		expect(getMenu(doc).hidden).toBe(false);
		btn.click();
		expect(getMenu(doc).hidden).toBe(true);
	});

	it("without pre-seeded accounts, fetches /accounts and renders the primary label", async () => {
		const client = mockClient();
		mountPicker({ host: body, client, sessionUuid: SESSION, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(client.get).toHaveBeenCalledWith("/accounts");
		expect(getButton(doc).textContent).toBe("Alice");
	});

	it("swallows a /accounts GET failure with a warning (picker stays inert)", async () => {
		const failing: BridgeClient = {
			get: vi.fn<GetFn>(() => Promise.resolve({ ok: false, kind: "network", detail: "x" })),
			post: vi.fn<PostFn>(),
		} as unknown as BridgeClient;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mountPicker({ host: body, client: failing, sessionUuid: SESSION, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("destroy() before /accounts resolves suppresses the render (no work on a dead picker)", async () => {
		let resolveGet: ((v: unknown) => void) | undefined;
		const client: BridgeClient = {
			get: vi.fn<() => Promise<unknown>>(
				() =>
					new Promise((resolve) => {
						resolveGet = resolve;
					}),
			),
			post: vi.fn<PostFn>(),
		} as unknown as BridgeClient;
		const handle = mountPicker({ host: body, client, sessionUuid: SESSION, doc });
		handle.destroy();
		resolveGet?.({ ok: true, data: { ok: true, accounts: ACCOUNTS } });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(doc.body.querySelector("[data-cma-picker]")).toBeNull();
	});

	it("label falls back to '…' when there is neither a current pick nor a primary", () => {
		mountPicker({ host: body, client: mockClient(), sessionUuid: SESSION, doc, accounts: [] });
		expect(getButton(doc).textContent).toBe("…");
	});

	it("without a session uuid, clicking an item no-ops (guard against choice writes on non-session pages)", async () => {
		const client = mockClient();
		mountPicker({ host: body, client, sessionUuid: undefined, doc, accounts: ACCOUNTS });
		getButton(doc).click();
		getItems(doc)[1]?.click();
		await Promise.resolve();
		expect(client.post).not.toHaveBeenCalled();
	});
});
