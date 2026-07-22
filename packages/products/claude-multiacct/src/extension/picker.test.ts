/**
 * Intent: the picker is a light-DOM Claude-styled button + portal menu (see
 * `picker.ts` docstring for why light DOM won over shadow DOM). Every test
 * here pins one load-bearing behaviour of that surface:
 *
 *  - Button label mirrors the current pick (or, before any pick, the first
 *    account as a hint, or the "…" fallback when the pool is empty).
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
	{ uuid: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", label: "Alice" },
	{ uuid: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", label: "Bob" },
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

	it("renders the first account's label as a hint by default on the light-DOM button", () => {
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

	it("clicking a menu item POSTs the choice with the session uuid and body", async () => {
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

	it("closes the menu on a click outside the button and menu", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		getButton(doc).click();
		expect(getMenu(doc).hidden).toBe(false);
		// A capture-phase document click whose target is neither the button nor
		// inside the menu must close the menu (the outside-click dismissal).
		const outside = doc.createElement("div");
		body.append(outside);
		outside.dispatchEvent(new doc.defaultView!.Event("click", { bubbles: true }));
		expect(getMenu(doc).hidden).toBe(true);
	});

	it("exposes the current pick via currentUuid() — undefined before any pick, set after", async () => {
		const handle = mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		// No stored primary: nothing is selected until the user picks.
		expect(handle.currentUuid()).toBeUndefined();
		getButton(doc).click();
		getItems(doc)[1]?.click();
		await Promise.resolve();
		expect(handle.currentUuid()).toBe(ACCOUNTS[1]?.uuid);
	});

	it("pre-selects and highlights the runtime-active account from activeUuid", () => {
		// The whole point of the runtime-primary derivation: the account
		// Claude.app is logged in as starts highlighted, not the first-account
		// hint. Drop the `currentUuid = opts.activeUuid` seed and this flips red.
		const handle = mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
			activeUuid: ACCOUNTS[1]?.uuid,
		});
		expect(handle.currentUuid()).toBe(ACCOUNTS[1]?.uuid);
		expect(getButton(doc).textContent).toBe("Bob");
		const items = getItems(doc);
		expect(items[1]?.dataset.selected).toBe("true");
		expect(items[0]?.dataset.selected).toBeUndefined();
	});

	it("adopts the runtime-active account from the /accounts response when self-fetching", async () => {
		const client: BridgeClient = {
			get: vi.fn<GetFn>(() =>
				Promise.resolve({
					ok: true,
					data: { ok: true, accounts: ACCOUNTS, activeUuid: ACCOUNTS[1]?.uuid },
				}),
			),
			post: vi.fn<PostFn>(),
		} as unknown as BridgeClient;
		const handle = mountPicker({ host: body, client, sessionUuid: SESSION, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		// The fetched activeUuid drives the highlight when accounts aren't pre-seeded.
		expect(handle.currentUuid()).toBe(ACCOUNTS[1]?.uuid);
		expect(getButton(doc).textContent).toBe("Bob");
	});

	it("keeps an explicitly-provided activeUuid over the one in the /accounts response", async () => {
		// Guard branch: a caller-supplied activeUuid must not be overwritten by
		// the fetched one. Remove the `currentUuid === undefined` guard and the
		// fetched Alice would clobber the provided Bob, flipping this red.
		const client: BridgeClient = {
			get: vi.fn<GetFn>(() =>
				Promise.resolve({
					ok: true,
					data: { ok: true, accounts: ACCOUNTS, activeUuid: ACCOUNTS[0]?.uuid },
				}),
			),
			post: vi.fn<PostFn>(),
		} as unknown as BridgeClient;
		const handle = mountPicker({
			host: body,
			client,
			sessionUuid: SESSION,
			doc,
			activeUuid: ACCOUNTS[1]?.uuid,
		});
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(handle.currentUuid()).toBe(ACCOUNTS[1]?.uuid);
	});

	it("without pre-seeded accounts, fetches /accounts and renders the first account's label", async () => {
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

	it("label falls back to '…' when there is no current pick and the pool is empty", () => {
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

	it("repositions the open menu on scroll/resize, but stays inert while hidden", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		const win = doc.defaultView!;
		const menu = getMenu(doc);

		// Menu hidden → a scroll must NOT reposition (reposition early-returns).
		menu.style.top = "";
		win.dispatchEvent(new win.Event("scroll"));
		expect(menu.style.top).toBe("");

		// Open it, clear the top it set, then scroll → reposition recomputes top.
		getButton(doc).click();
		expect(menu.hidden).toBe(false);
		menu.style.top = "";
		win.dispatchEvent(new win.Event("scroll"));
		expect(menu.style.top).not.toBe("");

		// Resize path is wired the same way.
		menu.style.top = "";
		win.dispatchEvent(new win.Event("resize"));
		expect(menu.style.top).not.toBe("");
	});

	it("swallows a /accounts GET that THROWS (rejects) with a warning", async () => {
		const throwing: BridgeClient = {
			get: vi.fn<GetFn>(() => Promise.reject(new Error("bridge offline"))),
			post: vi.fn<PostFn>(),
		} as unknown as BridgeClient;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mountPicker({ host: body, client: throwing, sessionUuid: SESSION, doc });
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			});
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("/accounts threw"),
				expect.anything(),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("rerender() rebuilds the button label + menu rows from current state", () => {
		const handle = mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		expect(getItems(doc)).toHaveLength(2);
		// Blow away the rendered rows + button label to prove rerender restores them.
		for (const item of getItems(doc)) {
			item.remove();
		}
		getButton(doc).textContent = "wiped";
		expect(getItems(doc)).toHaveLength(0);
		handle.rerender();
		expect(getItems(doc)).toHaveLength(2);
		expect(getButton(doc).textContent).toBe("Alice");
	});

	it("highlights a non-selected row on hover and leaves the selected row's highlight alone", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		// Nothing is selected up front (no stored primary); pick Alice so the
		// selected-row styling is live for the hover assertions below.
		getButton(doc).click();
		getItems(doc)[0]?.click();
		const [selected, other] = getItems(doc); // Alice is now the current pick
		other!.dispatchEvent(new doc.defaultView!.Event("mouseenter"));
		expect(other!.style.background).toBe("rgba(255, 255, 255, 0.08)");
		other!.dispatchEvent(new doc.defaultView!.Event("mouseleave"));
		expect(other!.style.background).toBe("transparent");
		// Hovering the selected row must not overwrite its highlight.
		selected!.dispatchEvent(new doc.defaultView!.Event("mouseenter"));
		expect(selected!.style.background).toBe("rgba(255, 255, 255, 0.06)");
	});

	it("keeps the menu open when a click lands inside the menu or on the button", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		getButton(doc).click();
		expect(getMenu(doc).hidden).toBe(false);
		// A capture-phase document click whose target is inside the menu → no close.
		const inside = new doc.defaultView!.Event("click", { bubbles: true });
		getMenu(doc).dispatchEvent(inside);
		expect(getMenu(doc).hidden).toBe(false);
	});

	it("logs a warning when the choice POST throws (not just when it returns !ok)", async () => {
		const throwing: BridgeClient = {
			get: vi.fn<GetFn>(() =>
				Promise.resolve({ ok: true, data: { ok: true, accounts: ACCOUNTS } }),
			),
			post: vi.fn<PostFn>(() => Promise.reject(new Error("post exploded"))),
		} as unknown as BridgeClient;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mountPicker({ host: body, client: throwing, sessionUuid: SESSION, doc, accounts: ACCOUNTS });
			getButton(doc).click();
			getItems(doc)[1]?.click();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			});
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("choose failed"),
				expect.anything(),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("reverts to an empty pick (previous ?? '') when the POST fails and there was no prior pick", async () => {
		// Nothing is pre-selected (no stored primary), so `currentUuid` starts
		// undefined even though the button hints the sole account's label. A
		// failed POST must revert to `previous ?? ""`, exercising the
		// undefined-previous side of the revert.
		const single: PickerAccount[] = [
			{ uuid: "cccccccc-cccc-4ccc-cccc-cccccccccccc", label: "Carol" },
		];
		const onChoice = vi.fn<(uuid: string) => void>();
		mountPicker({
			host: body,
			client: mockClient({ ok: false, kind: "network" }),
			sessionUuid: SESSION,
			doc,
			accounts: single,
			onChoice,
		});
		// The button hints the first account's label; no row is selected yet.
		expect(getButton(doc).textContent).toBe("Carol");
		getButton(doc).click();
		getItems(doc)[0]?.click();
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		// Reverted: label back to the hint and onChoice called with "" (no prior pick).
		expect(getButton(doc).textContent).toBe("Carol");
		expect(onChoice).toHaveBeenLastCalledWith("");
	});
});
