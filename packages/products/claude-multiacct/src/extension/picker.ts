/**
 * `@foundation/claude-multiacct` — account picker (light DOM, Claude-styled).
 *
 * Renders a button next to Claude's model selector in the Code-tab bottom
 * bar, and a dropdown menu positioned above it. Both use Claude's own
 * Tailwind + design-system classes (light DOM, no shadow) so the visual
 * result matches Claude's native dropdowns exactly — a shadow-DOM version
 * couldn't reach `bg-surface-3` / `rounded-card` / `shadow-panel` / etc.
 *
 * Class strings captured live from Claude Desktop's user-menu popup on
 * 2026-07-21; a Tailwind rename in Claude would require an update.
 *
 * @module
 */

import type { BridgeClient, BridgeResult } from "./bridge-client.ts";

export type PickerAccount = {
	uuid: string;
	label: string;
};

export type MountPickerOptions = {
	host: Element;
	client: BridgeClient;
	sessionUuid: string | undefined;
	doc: Document;
	accounts?: PickerAccount[];
	onChoice?: (accountUuid: string) => void;
};

export type PickerHandle = {
	destroy(): void;
	/** Force re-render of the button label + menu items (used by usage.ts). */
	rerender(): void;
	/** Current selected account uuid (undefined before first render). */
	currentUuid(): string | undefined;
};

// Tailwind classes are best-effort: Claude's JIT-compiled CSS may or may not
// include a given utility for our injected DOM, so every load-bearing visual
// (background, border, shadow, text color, radius) is ALSO set inline via
// CSS variables Claude defines on `:root` — that way an unmapped utility
// class still lands on the right pixels. The utility class strings are kept
// alongside for future Tailwind-config unification.
const BUTTON_CLASSES = "cds-reset";
const MENU_CLASSES = "cds-reset";
const MENU_INNER_CLASSES = "";
const MENU_HEADER_CLASSES = "";
const MENU_ITEM_CLASSES = "cds-reset";

/**
 * Apply inline styles that pin the picker button to Claude's model-selector look.
 *
 * @param {HTMLElement} el - Button element to style.
 * @returns {void}
 */
function styleButton(el: HTMLElement): void {
	el.style.display = "inline-flex";
	el.style.alignItems = "center";
	el.style.padding = "0 6px";
	el.style.margin = "0";
	el.style.border = "0";
	el.style.background = "transparent";
	el.style.color = "inherit";
	el.style.font = "inherit";
	el.style.cursor = "default";
	el.style.outline = "none";
	el.style.userSelect = "none";
	el.style.opacity = "0.9";
}

/**
 * Apply inline styles that mimic Claude's user-menu popup card.
 *
 * @param {HTMLElement} el - Menu container element to style.
 * @returns {void}
 */
function styleMenu(el: HTMLElement): void {
	el.style.position = "fixed";
	el.style.zIndex = "2147483647";
	el.style.minWidth = "220px";
	el.style.maxWidth = "320px";
	el.style.width = "17rem";
	el.style.padding = "4px";
	el.style.borderRadius = "12px";
	el.style.border = "1px solid rgba(255, 255, 255, 0.08)";
	// Claude's `bg-surface-3` is an app-theme dark. Fallback chain covers
	// the case where the CSS variable isn't defined on the visited page.
	el.style.background =
		"var(--surface-3, var(--color-bg-surface-3, var(--background-primary, rgb(30, 30, 32))))";
	el.style.color = "var(--text-primary, rgb(228, 228, 231))";
	el.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4)";
	el.style.fontFamily = "inherit";
	el.style.fontSize = "13px";
	el.style.lineHeight = "1.4";
}

/**
 * Style the small section-header line inside the picker menu.
 *
 * @param {HTMLElement} el - Header element to style.
 * @returns {void}
 */
function styleHeader(el: HTMLElement): void {
	el.style.padding = "6px 10px 4px";
	el.style.fontSize = "11px";
	el.style.fontWeight = "600";
	el.style.opacity = "0.55";
	el.style.textTransform = "none";
	el.style.letterSpacing = "0";
}

/**
 * Style one menu row; selected rows get a subtle highlight.
 *
 * @param {HTMLElement} el - Menuitem element to style.
 * @param {boolean} isSelected - Whether this row is the current pick.
 * @returns {void}
 */
function styleItem(el: HTMLElement, isSelected: boolean): void {
	el.style.display = "flex";
	el.style.alignItems = "center";
	el.style.gap = "8px";
	el.style.padding = "6px 10px";
	el.style.margin = "0";
	el.style.borderRadius = "6px";
	el.style.cursor = "default";
	el.style.userSelect = "none";
	el.style.outline = "none";
	el.style.fontSize = "13px";
	el.style.color = "inherit";
	el.style.background = isSelected ? "rgba(255, 255, 255, 0.06)" : "transparent";
}

/**
 * Mount the picker onto `host`. Returns a handle whose `destroy()` removes
 * every DOM node the picker created and detaches its listeners.
 *
 * @param {MountPickerOptions} opts - Injected host, client, session id, doc.
 * @returns {PickerHandle} `{destroy, rerender, currentUuid}`.
 */
export function mountPicker(opts: MountPickerOptions): PickerHandle {
	const { doc } = opts;

	const button = doc.createElement("button");
	button.type = "button";
	button.dataset.cmaPicker = "";
	button.className = BUTTON_CLASSES;
	styleButton(button);
	button.setAttribute("aria-haspopup", "menu");
	button.setAttribute("aria-expanded", "false");
	button.setAttribute("aria-label", "Choose Claude account for this session");
	button.textContent = "…";
	opts.host.append(button);

	// Menu attaches to <body> (portal-style) so it isn't clipped by the
	// bottom-bar's overflow and can position freely above the button.
	const menu = doc.createElement("div");
	menu.dataset.cmaPickerMenu = "";
	menu.setAttribute("role", "menu");
	menu.className = MENU_CLASSES;
	styleMenu(menu);
	menu.hidden = true;
	doc.body.append(menu);

	const inner = doc.createElement("div");
	inner.className = MENU_INNER_CLASSES;
	inner.style.display = "flex";
	inner.style.flexDirection = "column";
	inner.style.gap = "0";
	menu.append(inner);

	const header = doc.createElement("div");
	header.setAttribute("role", "presentation");
	header.className = MENU_HEADER_CLASSES;
	styleHeader(header);
	header.textContent = "Account";
	inner.append(header);

	let currentUuid: string | undefined;
	let accounts: PickerAccount[] = opts.accounts ?? [];
	let destroyed = false;

	function labelFor(uuid: string | undefined): string {
		const found = accounts.find((a) => a.uuid === uuid);
		if (found !== undefined) {
			return found.label;
		}
		// No current pick yet: fall back to the first account in pool order,
		// which mirrors the runtime active-account fallback in the domain.
		return accounts[0]?.label ?? "…";
	}

	function refreshButton(): void {
		button.textContent = labelFor(currentUuid);
	}

	function renderItems(): void {
		// Remove old items but keep the header
		// Snapshot children before mutating — direct iteration would skip
		// items when we call child.remove() mid-loop. Array.from is safest;
		// spread would trigger unicorn/no-useless-spread here.
		const children = [];
		for (const c of inner.children) {
			children.push(c);
		}
		for (const child of children) {
			if (child !== header) {
				child.remove();
			}
		}
		for (const account of accounts) {
			const item = doc.createElement("div");
			item.setAttribute("role", "menuitem");
			item.setAttribute("tabindex", "-1");
			item.dataset.uuid = account.uuid;
			item.className = MENU_ITEM_CLASSES;
			const isSelected = account.uuid === currentUuid;
			styleItem(item, isSelected);
			if (isSelected) {
				item.dataset.selected = "true";
			}
			item.addEventListener("mouseenter", () => {
				if (!isSelected) {
					item.style.background = "rgba(255, 255, 255, 0.08)";
				}
			});
			item.addEventListener("mouseleave", () => {
				item.style.background = isSelected ? "rgba(255, 255, 255, 0.06)" : "transparent";
			});

			const checkSlot = doc.createElement("span");
			checkSlot.style.display = "inline-flex";
			checkSlot.style.width = "14px";
			checkSlot.style.justifyContent = "center";
			checkSlot.style.opacity = "0.85";
			checkSlot.textContent = isSelected ? "✓" : "";
			item.append(checkSlot);

			const label = doc.createElement("span");
			label.style.flex = "1 1 auto";
			label.style.minWidth = "0";
			label.style.overflow = "hidden";
			label.style.textOverflow = "ellipsis";
			label.style.whiteSpace = "nowrap";
			label.textContent = account.label;
			item.append(label);

			item.addEventListener("click", () => {
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
			inner.append(item);
		}
	}

	function positionMenu(): void {
		const btnRect = button.getBoundingClientRect();
		// Place above the button, right-aligned to it.
		menu.style.visibility = "hidden";
		menu.hidden = false;
		const menuRect = menu.getBoundingClientRect();
		const gap = 6;
		let top = btnRect.top - menuRect.height - gap;
		let left = btnRect.right - menuRect.width;
		// Clamp so it stays on-screen
		if (top < 8) {
			top = btnRect.bottom + gap;
		}
		if (left < 8) {
			left = 8;
		}
		menu.style.top = `${String(Math.round(top))}px`;
		menu.style.left = `${String(Math.round(left))}px`;
		menu.style.visibility = "visible";
	}

	function openMenu(): void {
		button.setAttribute("aria-expanded", "true");
		positionMenu();
	}

	function closeMenu(): void {
		menu.hidden = true;
		button.setAttribute("aria-expanded", "false");
	}

	async function choose(uuid: string): Promise<void> {
		const previous = currentUuid;
		currentUuid = uuid;
		refreshButton();
		renderItems();
		opts.onChoice?.(uuid);
		closeMenu();
		// Only persist the choice when we're inside a real session
		// (`/new` and other pre-session URLs have no session uuid). The
		// visual switch above happens either way so the user gets feedback
		// on the click.
		if (opts.sessionUuid === undefined) {
			return;
		}
		const result: BridgeResult<unknown> = await opts.client.post(`/choice/${opts.sessionUuid}`, {
			accountUuid: uuid,
		});
		if (!result.ok) {
			currentUuid = previous;
			refreshButton();
			renderItems();
			opts.onChoice?.(previous ?? "");
		}
	}

	button.addEventListener("click", (event: Event) => {
		event.stopPropagation();
		if (menu.hidden) {
			openMenu();
		} else {
			closeMenu();
		}
	});

	// Close on any outside click.
	const outsideClick = (event: Event): void => {
		if (menu.hidden) {
			return;
		}
		const target = event.target as Node;
		if (menu.contains(target) || button.contains(target)) {
			return;
		}
		closeMenu();
	};
	doc.addEventListener("click", outsideClick, true);

	// Reposition on scroll/resize so it stays anchored.
	const reposition = (): void => {
		if (!menu.hidden) {
			positionMenu();
		}
	};
	opts.doc.defaultView?.addEventListener("scroll", reposition, true);
	opts.doc.defaultView?.addEventListener("resize", reposition);

	// Initial data: fetch from client if not pre-seeded. No account is marked
	// selected up front — there is no stored primary, and the runtime-derived
	// active account is wired in by the picker-styling work that follows. Until
	// then `currentUuid` stays undefined and the button shows the first
	// account's label as a hint (see `labelFor`).
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
		refreshButton();
		renderItems();
	}

	return {
		destroy(): void {
			destroyed = true;
			doc.removeEventListener("click", outsideClick, true);
			opts.doc.defaultView?.removeEventListener("scroll", reposition, true);
			opts.doc.defaultView?.removeEventListener("resize", reposition);
			button.remove();
			menu.remove();
		},
		rerender(): void {
			refreshButton();
			renderItems();
		},
		currentUuid(): string | undefined {
			return currentUuid;
		},
	};
}
