/**
 * `@foundation/claude-multiacct` — account picker component (vanilla DOM).
 *
 * Renders a button + dropdown listbox for choosing which pooled account a
 * given Code session runs against. Lives inside a Shadow DOM attached to
 * the caller-provided host, so page styles can't reach in and our styles
 * can't leak out — the Claude Code page ships its own aggressive design
 * system, and either direction of style bleed would be a support nightmare.
 *
 * The picker is optimistic: a click sends `POST /choice/:sessionUuid` and
 * updates the label immediately; a failed request reverts the label + logs
 * the failure kind. The caller (`content.ts`) owns re-mount on SPA
 * navigation, so `destroy()` is symmetric and idempotent.
 *
 * Accessibility: the toggle carries `aria-haspopup="listbox"`; the panel
 * is `role="listbox"`; items are `role="option"` with `aria-selected` on
 * the current pick. Arrow keys move focus within the panel; Enter
 * activates; Escape closes and returns focus to the toggle.
 *
 * @module
 */

import type { BridgeClient, BridgeResult } from "./bridge-client.ts";

export type PickerAccount = {
	uuid: string;
	label: string;
	isPrimary: boolean;
};

export type MountPickerOptions = {
	host: Element;
	client: BridgeClient;
	sessionUuid: string | undefined;
	doc: Document;
	/** Pre-fetched accounts for tests; production fetches from client. */
	accounts?: PickerAccount[];
	/** Called after each successful choice write. Tests observe activity here. */
	onChoice?: (accountUuid: string) => void;
};

export type PickerHandle = {
	destroy(): void;
};

const CSS = `
:host { all: initial; font-family: system-ui, sans-serif; }
.cma-btn {
	all: unset;
	cursor: pointer;
	padding: 4px 8px;
	border: 1px solid rgba(127, 127, 127, 0.4);
	border-radius: 6px;
	font-size: 12px;
	color: inherit;
	background: transparent;
}
.cma-btn[aria-expanded="true"] { background: rgba(127, 127, 127, 0.12); }
.cma-panel {
	position: absolute;
	margin-top: 4px;
	min-width: 200px;
	background: canvas;
	color: canvastext;
	border: 1px solid rgba(127, 127, 127, 0.4);
	border-radius: 6px;
	padding: 4px 0;
	list-style: none;
}
.cma-panel[hidden] { display: none; }
.cma-item {
	padding: 6px 12px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12px;
}
.cma-item[aria-selected="true"] { font-weight: 600; }
.cma-item:focus { outline: 2px solid CanvasText; outline-offset: -2px; }
`;

/**
 * Mount the picker onto `host`. Returns a handle whose `destroy()` removes
 * every DOM node the picker created and detaches its listeners.
 *
 * @param {MountPickerOptions} opts - Injected host, client, session id, doc.
 * @returns {PickerHandle} `{destroy}`.
 */
export function mountPicker(opts: MountPickerOptions): PickerHandle {
	const shadowHost = opts.doc.createElement("div");
	shadowHost.dataset.cmaPicker = "";
	opts.host.append(shadowHost);
	const shadow = shadowHost.attachShadow({ mode: "open" });

	const style = opts.doc.createElement("style");
	style.textContent = CSS;
	shadow.append(style);

	const button = opts.doc.createElement("button");
	button.className = "cma-btn";
	button.setAttribute("aria-haspopup", "listbox");
	button.setAttribute("aria-expanded", "false");
	button.setAttribute("aria-label", "Choose Claude account for this session");
	button.textContent = "Account: …";
	shadow.append(button);

	const panel = opts.doc.createElement("ul");
	panel.className = "cma-panel";
	panel.setAttribute("role", "listbox");
	panel.hidden = true;
	shadow.append(panel);

	let currentUuid: string | undefined;
	let accounts: PickerAccount[] = opts.accounts ?? [];
	let destroyed = false;

	function labelFor(uuid: string | undefined): string {
		const found = accounts.find((a) => a.uuid === uuid);
		if (found !== undefined) {
			return found.label;
		}
		const primary = accounts.find((a) => a.isPrimary);
		return primary?.label ?? "…";
	}

	function refreshButton(): void {
		button.textContent = `Account: ${labelFor(currentUuid)}`;
	}

	function renderItems(): void {
		panel.textContent = "";
		for (const account of accounts) {
			const li = opts.doc.createElement("li");
			li.className = "cma-item";
			li.setAttribute("role", "option");
			li.setAttribute("tabindex", "-1");
			li.dataset.uuid = account.uuid;
			li.setAttribute("aria-selected", account.uuid === currentUuid ? "true" : "false");
			li.textContent = account.label + (account.isPrimary ? " (primary)" : "");
			li.addEventListener("click", () => {
				// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget click handler
				(async (): Promise<void> => {
					try {
						await choose(account.uuid);
					} catch (error: unknown) {
						// eslint-disable-next-line no-console
						console.warn("[cma-extension] choose failed:", error);
					}
				})();
			});
			panel.append(li);
		}
	}

	function openPanel(): void {
		panel.hidden = false;
		button.setAttribute("aria-expanded", "true");
		const first = panel.querySelector<HTMLElement>(".cma-item");
		first?.focus();
	}

	function closePanel(): void {
		panel.hidden = true;
		button.setAttribute("aria-expanded", "false");
		button.focus();
	}

	async function choose(uuid: string): Promise<void> {
		if (opts.sessionUuid === undefined) {
			return;
		}
		const previous = currentUuid;
		currentUuid = uuid;
		refreshButton();
		renderItems();
		const result: BridgeResult<unknown> = await opts.client.post(`/choice/${opts.sessionUuid}`, {
			accountUuid: uuid,
		});
		if (!result.ok) {
			// Revert optimistic pick.
			currentUuid = previous;
			refreshButton();
			renderItems();

			return;
		}
		opts.onChoice?.(uuid);
		closePanel();
	}

	button.addEventListener("click", () => {
		if (panel.hidden) {
			openPanel();
		} else {
			closePanel();
		}
	});

	panel.addEventListener("keydown", (event: Event) => {
		const ke = event as KeyboardEvent;
		const items = [...panel.querySelectorAll<HTMLElement>(".cma-item")];
		const activeIndex = items.indexOf(shadow.activeElement as (typeof items)[number]);
		if (ke.key === "ArrowDown") {
			ke.preventDefault();
			const next = items[(activeIndex + 1) % items.length];
			next?.focus();
		} else if (ke.key === "ArrowUp") {
			ke.preventDefault();
			const prev = items[(activeIndex - 1 + items.length) % items.length];
			prev?.focus();
		} else if (ke.key === "Enter") {
			ke.preventDefault();
			const uuid = items[activeIndex]?.dataset.uuid;
			if (uuid !== undefined) {
				// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget key handler
				(async (): Promise<void> => {
					try {
						await choose(uuid);
					} catch {
						/* logged in choose */
					}
				})();
			}
		} else if (ke.key === "Escape") {
			ke.preventDefault();
			closePanel();
		}
	});

	// Initial data: fetch from client if not pre-seeded.
	if (opts.accounts === undefined) {
		// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget initial accounts fetch
		(async (): Promise<void> => {
			try {
				const res = await opts.client.get<{ ok: boolean; accounts: PickerAccount[] }>("/accounts");
				if (destroyed) {
					return;
				}
				if (res.ok && Array.isArray(res.data.accounts)) {
					({ accounts } = res.data);
					const primary = accounts.find((a) => a.isPrimary);
					currentUuid = primary?.uuid;
					refreshButton();
					renderItems();
				} else if (!res.ok) {
					// eslint-disable-next-line no-console
					console.warn("[cma-extension] /accounts failed:", res.kind, res.detail);
				}
			} catch (error: unknown) {
				// eslint-disable-next-line no-console
				console.warn("[cma-extension] /accounts threw:", error);
			}
		})();
	} else {
		const primary = accounts.find((a) => a.isPrimary);
		currentUuid = primary?.uuid;
		refreshButton();
		renderItems();
	}

	return {
		destroy(): void {
			destroyed = true;
			shadowHost.remove();
		},
	};
}
