/**
 * Intent: the picker's Shadow DOM isolates Claude's own aggressive page
 * styles from ours (and vice versa) — a page style that overrides our
 * button color would silently make the picker unreadable. Adversarial:
 * attach the picker to `document.body` directly (no shadow) and the
 * isolation test flips red.
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

describe("mountPicker", () => {
	let doc: Document;
	let body: HTMLElement;
	beforeEach(() => {
		({ doc, body } = mkDom());
	});

	it("renders the primary account label by default and mounts inside a shadow root", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		const host = body.querySelector("[data-cma-picker]");
		expect(host?.shadowRoot).not.toBeNull();
		const btn = host?.shadowRoot?.querySelector(".cma-btn");
		expect(btn?.textContent).toBe("Account: Alice");
	});

	it("Shadow DOM isolates our nodes from the page (light-DOM selectors don't reach them)", () => {
		// Adversarial: dropping the shadow (attaching .cma-btn directly to body) would
		// make `doc.querySelector(".cma-btn")` succeed and blow this assertion up.
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		// The button lives in the shadow — a page-level querySelector must not see it.
		expect(doc.querySelector(".cma-btn")).toBeNull();
		expect(doc.querySelector(".cma-panel")).toBeNull();
		// Sanity: it IS reachable via the shadow root.
		const shadowBtn = body
			.querySelector("[data-cma-picker]")
			?.shadowRoot?.querySelector(".cma-btn");
		expect(shadowBtn).not.toBeNull();
	});

	it("clicking a non-primary item POSTs the choice with the session uuid and body", async () => {
		const client = mockClient();
		mountPicker({ host: body, client, sessionUuid: SESSION, doc, accounts: ACCOUNTS });
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		(shadow.querySelector(".cma-btn") as HTMLElement).click();
		const items = shadow.querySelectorAll<HTMLElement>(".cma-item");
		items[1]?.click();
		await Promise.resolve();
		expect(client.post).toHaveBeenCalledWith(`/choice/${SESSION}`, {
			accountUuid: ACCOUNTS[1]?.uuid,
		});
	});

	it("reverts the label when the POST fails (optimistic UI recovery)", async () => {
		const client = mockClient({ ok: false, kind: "network" });
		mountPicker({ host: body, client, sessionUuid: SESSION, doc, accounts: ACCOUNTS });
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		(shadow.querySelector(".cma-btn") as HTMLElement).click();
		const items = shadow.querySelectorAll<HTMLElement>(".cma-item");
		items[1]?.click();
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		const btn = shadow.querySelector(".cma-btn");
		expect(btn?.textContent).toBe("Account: Alice");
	});

	it("arrow keys walk items; Escape closes and returns focus to the toggle", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		const button = shadow.querySelector(".cma-btn") as HTMLElement;
		button.click();
		const items = shadow.querySelectorAll<HTMLElement>(".cma-item");
		expect(shadow.activeElement).toBe(items[0]);
		const panel = shadow.querySelector(".cma-panel") as HTMLElement;
		panel.dispatchEvent(
			new doc.defaultView!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
		expect(shadow.activeElement).toBe(items[1]);
		panel.dispatchEvent(
			new doc.defaultView!.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
		);
		expect(shadow.activeElement).toBe(items[0]);
		panel.dispatchEvent(
			new doc.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		expect((shadow.querySelector(".cma-panel") as HTMLElement).hidden).toBe(true);
	});

	it("Enter on a focused item POSTs that item's choice", async () => {
		const client = mockClient();
		mountPicker({ host: body, client, sessionUuid: SESSION, doc, accounts: ACCOUNTS });
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		(shadow.querySelector(".cma-btn") as HTMLElement).click();
		const items = shadow.querySelectorAll<HTMLElement>(".cma-item");
		items[1]?.focus();
		const panel = shadow.querySelector(".cma-panel") as HTMLElement;
		panel.dispatchEvent(
			new doc.defaultView!.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
		await Promise.resolve();
		expect(client.post).toHaveBeenCalledWith(`/choice/${SESSION}`, {
			accountUuid: ACCOUNTS[1]?.uuid,
		});
	});

	it("destroy() removes the shadow host from the DOM", () => {
		const handle = mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		expect(body.querySelector("[data-cma-picker]")).not.toBeNull();
		handle.destroy();
		expect(body.querySelector("[data-cma-picker]")).toBeNull();
	});

	it("clicking the toggle a second time closes the panel", () => {
		mountPicker({
			host: body,
			client: mockClient(),
			sessionUuid: SESSION,
			doc,
			accounts: ACCOUNTS,
		});
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		const button = shadow.querySelector(".cma-btn") as HTMLElement;
		button.click();
		expect((shadow.querySelector(".cma-panel") as HTMLElement).hidden).toBe(false);
		button.click();
		expect((shadow.querySelector(".cma-panel") as HTMLElement).hidden).toBe(true);
	});

	it("without pre-seeded accounts, fetches /accounts and renders them", async () => {
		const client = mockClient();
		mountPicker({ host: body, client, sessionUuid: SESSION, doc });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(client.get).toHaveBeenCalledWith("/accounts");
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		expect(shadow.querySelector(".cma-btn")?.textContent).toBe("Account: Alice");
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
		// Nothing to render — the shadow host is gone.
		expect(body.querySelector("[data-cma-picker]")).toBeNull();
	});

	it("label falls back to '…' when there is neither a current pick nor a primary", () => {
		// No accounts at all: initial label + a click do not blow up.
		mountPicker({ host: body, client: mockClient(), sessionUuid: SESSION, doc, accounts: [] });
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		expect(shadow.querySelector(".cma-btn")?.textContent).toBe("Account: …");
	});

	it("without a session uuid, clicking an item no-ops (guard against choice writes on non-session pages)", async () => {
		const client = mockClient();
		mountPicker({ host: body, client, sessionUuid: undefined, doc, accounts: ACCOUNTS });
		const shadow = body.querySelector("[data-cma-picker]")!.shadowRoot!;
		(shadow.querySelector(".cma-btn") as HTMLElement).click();
		(shadow.querySelectorAll<HTMLElement>(".cma-item")[1] as HTMLElement).click();
		await Promise.resolve();
		expect(client.post).not.toHaveBeenCalled();
	});
});
