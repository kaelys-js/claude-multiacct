/**
 * `@foundation/claude-multiacct` — account picker (light DOM, Claude-styled).
 *
 * Renders a button next to Claude's model selector in the Code-tab bottom
 * bar, and a dropdown menu positioned above it. Light DOM (no shadow) so the
 * menu can reach the page's own theme variables and match Claude's native
 * dropdown pixel-for-pixel.
 *
 * The menu also carries pool management: each removable account row has a small
 * remove control (`DELETE /accounts/:uuid`) — the native/primary row shows none,
 * since it can't be removed. A trailing "+ Add account" row runs a real in-app
 * OAuth sign-in against the Claude account client's MANUAL copy-the-code redirect
 * (the account client rejects loopback, so there is no 127.0.0.1 callback). The
 * picker asks the daemon to start a login (`POST /accounts/login/start`) and to
 * open the authorize URL in the system browser (`POST /accounts/login/open/:id`;
 * the Electron renderer cannot open an external window itself). The browser lands
 * on the platform callback, which shows the user a `code#state` to copy. The
 * picker then reveals a paste panel; on submit it POSTs the pasted value to
 * `POST /accounts/login/complete` (`{loginId, code}`), which drives
 * exchange → profile → register host-side. An explicit in-DOM token-paste form
 * (`POST /accounts`) is offered as a fallback. Every success re-fetches
 * `/accounts` so the menu reflects the new pool without a page reload.
 *
 * The load-bearing surface values (panel background, border, text, radius,
 * shadow) are the real Claude design-system tokens, referenced as the page's
 * own CSS variables with resolved-hex fallbacks. Captured live on 2026-07-21
 * from `/Applications/Claude.app` (`app.asar` extracted with `@electron/asar`):
 *
 *   - panel bg   `--claude-background-color: #262624`  window-shared.css:161
 *   - border     `--claude-border: #eaddd81a`          window-shared.css:162
 *   - text       `--claude-text-100: #f5f4ef`          window-shared.css:165
 *   - muted text `--claude-secondary-color: #a6a39a`   window-shared.css:160
 *   - panel radius `rounded-xl` 0.75rem                index.html:2311
 *   - item radius  `rounded-lg` 0.5rem                 index.html:2302
 *   - popover shadow `0px 2px 8px 0px hsl(var(--always-black)/24%)`
 *                                                      index.html:3996
 *
 * (paths relative to `.vite/renderer/main_window/` in the extracted asar).
 * A Claude token rename would require re-capturing these.
 *
 * @module
 */

import type { BridgeClient, BridgeResult } from "./bridge-client.ts";

export type PickerAccount = {
	uuid: string;
	label: string;
	/**
	 * How the account entered the pool (from `/accounts`). The `native` account
	 * is what Claude.app is signed into and the pool's primary — it cannot be
	 * removed, so its row shows NO × control at all (an inert "×" that only ever
	 * errors is worse than none). Absent is treated as `explicit` (removable),
	 * mirroring the domain's default.
	 */
	source?: "native" | "explicit";
};

export type MountPickerOptions = {
	host: Element;
	client: BridgeClient;
	sessionUuid: string | undefined;
	doc: Document;
	accounts?: PickerAccount[];
	/**
	 * The runtime-derived active account uuid (the account Claude.app is
	 * currently authenticated as, per `discovery/active-token.ts`'s sha match).
	 * Pre-selects and highlights that row. Omitted when pre-seeding without a
	 * known active account; the self-fetch path reads it from `/accounts`.
	 */
	activeUuid?: string;
	onChoice?: (accountUuid: string) => void;
	/**
	 * Confirm a destructive remove. Returns true to proceed. Defaults to the
	 * document's `window.confirm`; injected so tests never open a real dialog.
	 */
	confirm?: (message: string) => boolean;
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
// Row highlight overlays. Claude's dark menus tint rows with a translucent
// white wash rather than a solid fill, so the panel color still reads through;
// the selected row sits a touch brighter than a passing hover.
const SELECTED_BG = "rgba(255, 255, 255, 0.06)";
const HOVER_BG = "rgba(255, 255, 255, 0.08)";

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
	// rounded-xl (0.75rem) — Claude's card/popover radius (index.html:2311).
	el.style.borderRadius = "0.75rem";
	// Real Claude tokens, theme-aware via the page's own variables with the
	// captured dark-theme hex as fallback (window-shared.css:161/162/165).
	el.style.border = "1px solid var(--claude-border, #eaddd81a)";
	el.style.background = "var(--claude-background-color, #262624)";
	el.style.color = "var(--claude-text-100, #f5f4ef)";
	// Claude's floating-panel shadow: shadow-[0px_2px_8px_0px_hsl(var(--always-black)/24%)]
	// (index.html:3996). --always-black resolves to black; fall back to rgba.
	el.style.boxShadow = "0px 2px 8px 0px hsl(var(--always-black, 0 0% 0%) / 0.24)";
	el.style.fontFamily = "inherit";
	el.style.fontSize = "0.875rem";
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
	el.style.fontSize = "0.75rem";
	el.style.fontWeight = "600";
	// Claude's muted label color (window-shared.css:160) instead of an opacity hack.
	el.style.color = "var(--claude-secondary-color, #a6a39a)";
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
	// rounded-lg (0.5rem) — Claude's menu-row radius (index.html:2302).
	el.style.borderRadius = "0.5rem";
	el.style.cursor = "default";
	el.style.userSelect = "none";
	el.style.outline = "none";
	el.style.fontSize = "inherit";
	el.style.color = "inherit";
	el.style.background = isSelected ? SELECTED_BG : "transparent";
}

/**
 * Style the small per-row remove ("×") control. Muted until hovered so it
 * reads as a secondary affordance next to the account label.
 *
 * @param {HTMLElement} el - The remove-button element to style.
 * @returns {void}
 */
function styleRemoveButton(el: HTMLElement): void {
	el.style.display = "inline-flex";
	el.style.alignItems = "center";
	el.style.justifyContent = "center";
	el.style.width = "16px";
	el.style.height = "16px";
	el.style.flex = "0 0 auto";
	el.style.padding = "0";
	el.style.border = "0";
	el.style.borderRadius = "0.25rem";
	el.style.background = "transparent";
	el.style.color = "var(--claude-secondary-color, #a6a39a)";
	el.style.font = "inherit";
	el.style.lineHeight = "1";
	el.style.cursor = "default";
	el.style.opacity = "0.7";
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

	// Confirm port. Default to the document view's own `window.confirm` (the
	// content script always has a view); tests inject a fake. `defaultView` is
	// non-null for both the extension document and jsdom, so the cast spends no
	// runtime branch on the null case.
	//
	// There is NO renderer-side browser open here. Electron's content script
	// cannot reach the system browser (an external `window.open` is a no-op, as
	// `window.prompt` was), so the DAEMON opens the authorize URL host-side — once
	// when the login starts, and again when the user clicks "Open the sign-in
	// page" (which POSTs `/accounts/login/open/:loginId`). Adding an account runs a
	// real OAuth sign-in and ends with the user pasting the browser-shown
	// `code#state` into a panel (see `startLogin` / `completeLogin`), with an
	// in-DOM token-paste form as an explicit fallback (see `renderTokenForm`).
	const view = doc.defaultView as Window & typeof globalThis;
	function defaultConfirm(message: string): boolean {
		return view.confirm(message);
	}
	const confirmFn = opts.confirm ?? defaultConfirm;

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

	let currentUuid: string | undefined = opts.activeUuid;
	let accounts: PickerAccount[] = opts.accounts ?? [];
	let destroyed = false;
	// Add-account area state. `pasting` reveals the code-paste panel while the user
	// finishes signing in in the browser; `error` shows `addMessage`;
	// `tokenFormOpen` reveals the token fallback.
	let addState: "idle" | "pasting" | "error" = "idle";
	let addMessage = "";
	let tokenFormOpen = false;
	// One-shot: focus the token input the render right after the form opens.
	let focusTokenOnRender = false;
	// One-shot: focus the code input the render right after the paste panel opens.
	let focusCodeOnRender = false;
	let activeLoginId: string | undefined;
	// The authorize URL of the in-flight login, surfaced as a clickable link in
	// the paste panel so the user always has a reliable way to (re)open it.
	let activeAuthorizeUrl: string | undefined;

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
					item.style.background = HOVER_BG;
				}
			});
			item.addEventListener("mouseleave", () => {
				item.style.background = isSelected ? SELECTED_BG : "transparent";
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

			// The native account is the pool anchor Claude.app is signed into; the
			// daemon refuses to remove it (409). Rather than render an inert × that
			// only ever errors, the native row gets NO remove control at all — every
			// visible × is a working one. Explicit accounts get the real remove ×.
			if (account.source !== "native") {
				const removeBtn = doc.createElement("button");
				removeBtn.type = "button";
				removeBtn.className = "cds-reset";
				removeBtn.textContent = "×";
				styleRemoveButton(removeBtn);
				removeBtn.dataset.cmaRemove = account.uuid;
				removeBtn.setAttribute("aria-label", `Remove ${account.label}`);
				removeBtn.addEventListener("mouseenter", () => {
					removeBtn.style.opacity = "1";
				});
				removeBtn.addEventListener("mouseleave", () => {
					removeBtn.style.opacity = "0.7";
				});
				removeBtn.addEventListener("click", (event: Event) => {
					// Never let the remove click bubble to the row's choose handler.
					event.stopPropagation();
					// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget click handler
					(async (): Promise<void> => {
						try {
							await removeChosen(account);
						} catch (error: unknown) {
							// eslint-disable-next-line no-console
							console.warn("[cma-extension] remove failed:", error);
						}
					})();
				});
				item.append(removeBtn);
			}

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

		renderAddArea();
	}

	// A muted, non-selectable status line (used for "waiting", errors, hints).
	function statusRow(dataAttr: string, text: string): HTMLDivElement {
		const row = doc.createElement("div");
		row.setAttribute("role", "presentation");
		row.dataset[dataAttr] = "";
		styleItem(row, false);
		row.style.color = "var(--claude-secondary-color, #a6a39a)";
		row.style.cursor = "default";
		row.textContent = text;
		return row;
	}

	// A clickable menu row with the shared hover behavior.
	function actionRow(dataAttr: string, text: string, onClick: () => void): HTMLDivElement {
		const row = doc.createElement("div");
		row.setAttribute("role", "menuitem");
		row.setAttribute("tabindex", "-1");
		row.dataset[dataAttr] = "";
		row.className = MENU_ITEM_CLASSES;
		styleItem(row, false);
		row.style.color = "var(--claude-secondary-color, #a6a39a)";
		row.textContent = text;
		row.addEventListener("mouseenter", () => {
			row.style.background = HOVER_BG;
		});
		row.addEventListener("mouseleave", () => {
			row.style.background = "transparent";
		});
		row.addEventListener("click", onClick);
		return row;
	}

	// A 1px hairline divider on Claude's border token, with breathing room. Used to
	// separate the account LIST from the add area, and the token form from the
	// entries above it, so the add controls don't crowd the last account row.
	function divider(dataAttr: string): HTMLDivElement {
		const line = doc.createElement("div");
		line.dataset[dataAttr] = "";
		line.setAttribute("role", "separator");
		line.style.height = "0";
		line.style.margin = "6px 4px";
		line.style.borderTop = "1px solid var(--claude-border, #eaddd81a)";
		return line;
	}

	// A styled action button for the add/paste/token forms. `filled` is the
	// primary/accent action (a light fill with dark text — readable on the dark
	// menu, and still legible in a light theme where the tokens invert); `ghost`
	// is the muted secondary like `actionRow`. Both are theme-aware via Claude's
	// CSS vars with hex fallbacks and carry hover states.
	function styledButton(cfg: {
		text: string;
		dataAttr: string;
		variant: "filled" | "ghost";
	}): HTMLButtonElement {
		const btn = doc.createElement("button");
		btn.type = "button";
		btn.dataset[cfg.dataAttr] = "";
		btn.className = "cds-reset";
		btn.textContent = cfg.text;
		// Padding tuned to the tokenField inputs (5px 8px) so buttons and fields
		// share a rhythm; radius matches the fields' 0.375rem.
		btn.style.padding = "5px 12px";
		btn.style.borderRadius = "0.375rem";
		btn.style.font = "inherit";
		btn.style.fontSize = "0.8125rem";
		btn.style.lineHeight = "1.2";
		btn.style.cursor = "pointer";
		btn.style.userSelect = "none";
		if (cfg.variant === "filled") {
			btn.style.border = "1px solid transparent";
			btn.style.background = "var(--claude-text-100, #f5f4ef)";
			btn.style.color = "var(--claude-background-color, #262624)";
			btn.style.fontWeight = "600";
			btn.addEventListener("mouseenter", () => {
				btn.style.opacity = "0.85";
			});
			btn.addEventListener("mouseleave", () => {
				btn.style.opacity = "1";
			});
		} else {
			btn.style.border = "1px solid var(--claude-border, #eaddd81a)";
			btn.style.background = "transparent";
			btn.style.color = "var(--claude-secondary-color, #a6a39a)";
			btn.addEventListener("mouseenter", () => {
				btn.style.background = HOVER_BG;
			});
			btn.addEventListener("mouseleave", () => {
				btn.style.background = "transparent";
			});
		}
		return btn;
	}

	// The add-account area. Visual states: idle (the "+ Add account" OAuth entry
	// plus the token-paste fallback toggle), pasting (the code-paste panel while
	// the user finishes signing in in the browser), and error (an inline message
	// above the idle entries). A divider always separates it from the account list
	// above. Rendered fresh on every `renderItems`.
	function renderAddArea(): void {
		// Clear separation between the account LIST and the add area.
		inner.append(divider("cmaAddDivider"));

		if (addState === "pasting") {
			renderPastePanel();
			return;
		}

		if (addState === "error") {
			inner.append(statusRow("cmaAddError", addMessage));
		}

		inner.append(
			actionRow("cmaAddAccount", "+ Add account", () => {
				// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget click handler
				(async (): Promise<void> => {
					try {
						await startLogin();
					} catch (error: unknown) {
						addState = "error";
						addMessage = "Couldn't start sign-in. Is the account pool enabled?";
						renderItems();
						// eslint-disable-next-line no-console
						console.warn("[cma-extension] start login failed:", error);
					}
				})();
			}),
		);

		if (tokenFormOpen) {
			renderTokenForm();
		} else {
			inner.append(
				actionRow("cmaAddToken", "Add via token instead", () => {
					tokenFormOpen = true;
					focusTokenOnRender = true;
					addState = "idle";
					renderItems();
					positionMenu();
				}),
			);
		}
	}

	// The code-paste panel: shown after the daemon opens the browser. The user
	// signs in there, copies the `code#state` the platform callback shows, and
	// pastes it here. Submitting POSTs it to /accounts/login/complete. An "Open the
	// sign-in page" link re-asks the daemon to open the authorize URL (the renderer
	// cannot). Styled Add/Cancel match the token form.
	function renderPastePanel(): void {
		const panel = doc.createElement("div");
		panel.dataset.cmaCodeForm = "";
		panel.style.display = "flex";
		panel.style.flexDirection = "column";
		panel.style.gap = "6px";
		panel.style.padding = "6px 10px";

		const hint = doc.createElement("div");
		hint.dataset.cmaCodeHint = "";
		hint.textContent = "Sign in in your browser, then paste the code it shows you.";
		hint.style.fontSize = "0.75rem";
		hint.style.color = "var(--claude-secondary-color, #a6a39a)";
		panel.append(hint);

		// "Open the sign-in page" — the renderer can't reach the system browser, so
		// this asks the DAEMON to (re)open it via POST /accounts/login/open/:id. The
		// daemon already opened it once on start; this is the reliable retry. `href`
		// is kept for transparency; the click is intercepted (never a renderer nav).
		// `activeLoginId`/`activeAuthorizeUrl` are invariants of the pasting state.
		const link = doc.createElement("a");
		link.dataset.cmaLoginLink = "";
		/* c8 ignore next 3 -- activeAuthorizeUrl is always set when the paste panel shows; guard is defensive */
		if (activeAuthorizeUrl !== undefined) {
			link.href = activeAuthorizeUrl;
		}
		link.target = "_blank";
		link.rel = "noopener";
		link.textContent = "Open the sign-in page";
		link.style.color = "var(--claude-text-100, #f5f4ef)";
		link.style.textDecoration = "underline";
		link.style.cursor = "pointer";
		link.style.fontSize = "0.75rem";
		link.addEventListener("click", (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget: the daemon already opened once, this is a retry
			openSignInPage();
		});
		panel.append(link);

		// An inline error while still on the paste panel (empty code, or a failed
		// complete request that leaves the login retryable).
		if (addMessage !== "") {
			const err = statusRow("cmaAddError", addMessage);
			err.style.padding = "0";
			panel.append(err);
		}

		const { field: codeFieldEl, input: codeInput } = tokenField({
			labelText: "Paste the code from your browser",
			dataAttr: "cmaCodeInput",
			type: "text",
			placeholder: "Paste code here",
		});

		const submit = styledButton({ text: "Add", dataAttr: "cmaCodeSubmit", variant: "filled" });
		const cancel = styledButton({ text: "Cancel", dataAttr: "cmaCodeCancel", variant: "ghost" });

		// Disable the submit while the POST is in flight so a double-submit can't
		// fire two completes; a re-render (error or refetch) restores it.
		const runSubmit = (): void => {
			if (submit.disabled) {
				return;
			}
			submit.disabled = true;
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget submit; completeLogin re-renders on completion
			completeLogin(codeInput.value);
		};

		submit.addEventListener("click", (event: Event) => {
			event.stopPropagation();
			runSubmit();
		});
		cancel.addEventListener("click", (event: Event) => {
			event.stopPropagation();
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget click handler
			(async (): Promise<void> => {
				await cancelLogin();
			})();
		});
		codeInput.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				runSubmit();
			}
		});

		const buttons = doc.createElement("div");
		buttons.style.display = "flex";
		buttons.style.gap = "6px";
		buttons.append(submit, cancel);

		// Clicks inside the panel must not bubble to the outside-close handler.
		panel.addEventListener("click", (event: Event) => event.stopPropagation());
		panel.append(codeFieldEl, buttons);
		inner.append(panel);
		if (focusCodeOnRender) {
			focusCodeOnRender = false;
			codeInput.focus();
		}
	}

	// A labelled input styled to sit on Claude's dark menu panel (not a bright
	// white box). Returns the input so the caller can wire focus/keydown.
	function tokenField(cfg: {
		labelText: string;
		dataAttr: string;
		type: "text" | "password";
		placeholder: string;
	}): { field: HTMLLabelElement; input: HTMLInputElement } {
		const field = doc.createElement("label");
		field.style.display = "flex";
		field.style.flexDirection = "column";
		field.style.gap = "3px";
		const caption = doc.createElement("span");
		caption.textContent = cfg.labelText;
		caption.style.fontSize = "0.75rem";
		caption.style.color = "var(--claude-secondary-color, #a6a39a)";
		const input = doc.createElement("input");
		input.dataset[cfg.dataAttr] = "";
		input.type = cfg.type;
		input.placeholder = cfg.placeholder;
		// Dark-panel field styling: a faint white wash on the #262624 menu, the
		// same Claude border/text tokens the menu itself uses — never a white box.
		input.style.width = "100%";
		input.style.boxSizing = "border-box";
		input.style.padding = "5px 8px";
		input.style.background = "rgba(255, 255, 255, 0.04)";
		input.style.border = "1px solid var(--claude-border, #eaddd81a)";
		input.style.borderRadius = "0.375rem";
		input.style.color = "var(--claude-text-100, #f5f4ef)";
		input.style.font = "inherit";
		input.style.outline = "none";
		field.append(caption, input);
		return { field, input };
	}

	// Explicit fallback: an in-DOM token-paste form (Electron has no
	// window.prompt, so the collector must be real DOM). Real <label>s + token
	// inputs POST straight to /accounts, the same provisioning path the OAuth flow
	// ends in. This is a fallback IN ADDITION to the OAuth login, never instead of
	// it — a Cancel returns to the OAuth entry.
	function renderTokenForm(): void {
		const form = doc.createElement("div");
		form.dataset.cmaTokenForm = "";
		form.style.display = "flex";
		form.style.flexDirection = "column";
		form.style.gap = "6px";
		form.style.padding = "6px 10px";

		const { field: labelField, input: labelInput } = tokenField({
			labelText: "Account name (optional)",
			dataAttr: "cmaTokenLabel",
			type: "text",
			placeholder: "e.g. Work",
		});
		const { field: tokenFieldEl, input: tokenInput } = tokenField({
			labelText: "OAuth token",
			dataAttr: "cmaTokenInput",
			type: "password",
			placeholder: "Paste OAuth token",
		});

		const submit = styledButton({ text: "Add", dataAttr: "cmaTokenSubmit", variant: "filled" });
		const cancel = styledButton({ text: "Cancel", dataAttr: "cmaTokenCancel", variant: "ghost" });

		// Disable the submit while the POST is in flight so a double-click can't
		// fire two provisioning requests; a re-render (error or refetch) restores it.
		const runSubmit = (): void => {
			if (submit.disabled) {
				return;
			}
			submit.disabled = true;
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget submit; submitToken re-renders on completion
			submitToken(labelInput.value, tokenInput.value);
		};

		submit.addEventListener("click", (event: Event) => {
			event.stopPropagation();
			runSubmit();
		});
		cancel.addEventListener("click", (event: Event) => {
			event.stopPropagation();
			// Back to the OAuth entry — close the form and clear any error.
			tokenFormOpen = false;
			addState = "idle";
			addMessage = "";
			renderItems();
			positionMenu();
		});
		// Enter anywhere in the token field submits (the common one-field flow).
		tokenInput.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				runSubmit();
			}
		});

		const buttons = doc.createElement("div");
		buttons.style.display = "flex";
		buttons.style.gap = "6px";
		buttons.append(submit, cancel);

		// Clicks inside the form must not bubble to the outside-close handler.
		form.addEventListener("click", (event: Event) => event.stopPropagation());
		form.append(labelField, tokenFieldEl, buttons);
		// A clean separator above the token form panel.
		inner.append(divider("cmaTokenDivider"));
		inner.append(form);
		// Autofocus the token field when the form first opens (not on every
		// re-render, or it would steal focus mid-typing).
		if (focusTokenOnRender) {
			focusTokenOnRender = false;
			tokenInput.focus();
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

	// Re-pull the pool from the daemon after a mutation so the menu reflects
	// the new set without a page reload. A dead picker, a failed request, or a
	// non-array payload leaves the menu as-is. When the selected account is gone
	// (just removed), `labelFor` falls back to the first-account hint, so no
	// explicit reset is needed here.
	async function refetchAccounts(): Promise<void> {
		const res = await opts.client.get<{ ok: boolean; accounts: PickerAccount[] }>("/accounts");
		if (destroyed || !res.ok || !Array.isArray(res.data.accounts)) {
			return;
		}
		({ accounts } = res.data);
		refreshButton();
		renderItems();
	}

	// "+ Add account" — start a real OAuth sign-in. Ask the daemon to build the
	// authorize URL (manual copy-the-code redirect), then to open it host-side (the
	// renderer can't). Only once the start succeeds do we reveal the paste panel —
	// so the user never sees it unless the browser open was actually requested. The
	// user finishes in the browser, copies the shown `code#state`, and pastes it.
	async function startLogin(): Promise<void> {
		type StartData = { ok: boolean; loginId?: string; authorizeUrl?: string };
		const started: BridgeResult<StartData> = await opts.client.post("/accounts/login/start", {});
		if (
			!started.ok ||
			typeof started.data.loginId !== "string" ||
			typeof started.data.authorizeUrl !== "string"
		) {
			addState = "error";
			addMessage = "Couldn't start sign-in. Is the account pool enabled?";
			renderItems();
			return;
		}
		activeLoginId = started.data.loginId;
		activeAuthorizeUrl = started.data.authorizeUrl;
		// Ask the daemon to open the authorize URL host-side (non-fatal on failure —
		// the paste panel still offers an "Open the sign-in page" retry link).
		await openSignInPage();
		addState = "pasting";
		addMessage = "";
		tokenFormOpen = false;
		focusCodeOnRender = true;
		renderItems();
		positionMenu();
	}

	// Ask the daemon to (re-)open the authorize URL host-side. Backs the "Open the
	// sign-in page" link and the initial open on start. `activeLoginId` is always
	// set by the time this runs. A failure is swallowed (and warned) — the user can
	// still open the page manually from the link's href.
	async function openSignInPage(): Promise<void> {
		try {
			await opts.client.post(`/accounts/login/open/${String(activeLoginId)}`, {});
		} catch (error: unknown) {
			// eslint-disable-next-line no-console
			console.warn("[cma-extension] open sign-in page failed:", error);
		}
	}

	// Submit the pasted `code#state` to /accounts/login/complete. The daemon runs
	// exchange → profile → register and returns the login's final status. On `done`
	// refresh the pool; otherwise surface a clean inline error (never a raw stack).
	async function completeLogin(codeRaw: string): Promise<void> {
		const code = codeRaw.trim();
		if (code === "") {
			// Stay on the paste panel — the user just needs to paste the code.
			addMessage = "Paste the code first.";
			renderItems();
			return;
		}
		type CompleteData = { ok: boolean; status?: string; detail?: string };
		const res: BridgeResult<CompleteData> = await opts.client.post("/accounts/login/complete", {
			loginId: activeLoginId,
			code,
		});
		if (!res.ok) {
			// The request itself failed (network). The pending login is still valid,
			// so keep the paste panel for a retry rather than tearing it down.
			addMessage = "Couldn't reach the sign-in service. Try again.";
			renderItems();
			// eslint-disable-next-line no-console
			console.warn("[cma-extension] complete login failed:", res.kind, res.detail);
			return;
		}
		if (res.data.status === "done") {
			activeLoginId = undefined;
			activeAuthorizeUrl = undefined;
			addState = "idle";
			addMessage = "";
			await refetchAccounts();
			return;
		}
		// The daemon reports a non-done terminal status (a rejected code or a state
		// mismatch): the login is consumed, so drop back to the idle add entry with
		// the detail surfaced, and the user can restart cleanly.
		activeLoginId = undefined;
		activeAuthorizeUrl = undefined;
		addState = "error";
		addMessage = res.data.detail ?? "That code was rejected. Try adding the account again.";
		renderItems();
	}

	// Cancel a pending sign-in: return the add area to idle and tell the daemon to
	// drop the pending login. Clearing `activeLoginId` prevents any late complete.
	async function cancelLogin(): Promise<void> {
		const loginId = activeLoginId;
		activeLoginId = undefined;
		activeAuthorizeUrl = undefined;
		addState = "idle";
		addMessage = "";
		renderItems();
		positionMenu();
		if (loginId !== undefined) {
			await opts.client.post(`/accounts/login/cancel/${loginId}`, {});
		}
	}

	// Fallback path: submit a hand-pasted OAuth token to /accounts. Empty token
	// aborts without a request (Rule 12: no silent empty writes).
	async function submitToken(labelRaw: string, tokenRaw: string): Promise<void> {
		const token = tokenRaw.trim();
		if (token === "") {
			addState = "error";
			addMessage = "Paste a token first.";
			renderItems();
			return;
		}
		const label =
			labelRaw.trim() === "" ? `Pasted ${new Date().toISOString().slice(0, 10)}` : labelRaw.trim();
		const result: BridgeResult<unknown> = await opts.client.post("/accounts", { label, token });
		if (!result.ok) {
			addState = "error";
			addMessage = "That token was rejected.";
			renderItems();
			// eslint-disable-next-line no-console
			console.warn("[cma-extension] add account (token) failed:", result.kind, result.detail);
			return;
		}
		tokenFormOpen = false;
		addState = "idle";
		addMessage = "";
		await refetchAccounts();
	}

	// The label of the account sessions fall back to when `exceptUuid` is
	// removed: the native (primary) account, else the first other account. Used
	// in the remove confirmation so the user sees the consequence of removal.
	function primaryLabelExcept(exceptUuid: string): string {
		const native = accounts.find((a) => a.source === "native" && a.uuid !== exceptUuid);
		if (native !== undefined) {
			return native.label;
		}
		const other = accounts.find((a) => a.uuid !== exceptUuid);
		return other?.label ?? "the primary account";
	}

	// Per-row remove — confirm, DELETE, then refresh. A declined confirm aborts.
	// The confirmation states the consequence: sessions pinned to this account
	// switch to the primary account.
	async function removeChosen(account: PickerAccount): Promise<void> {
		const ok = confirmFn(
			`Sessions using "${account.label}" will switch to "${primaryLabelExcept(account.uuid)}". Remove "${account.label}" and delete its stored token?`,
		);
		if (!ok) {
			return;
		}
		closeMenu();
		const result: BridgeResult<unknown> = await opts.client.del(`/accounts/${account.uuid}`);
		if (!result.ok) {
			// eslint-disable-next-line no-console
			console.warn("[cma-extension] remove account failed:", result.kind, result.detail);
			return;
		}
		await refetchAccounts();
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

	// Initial data: fetch from client if not pre-seeded. The runtime-derived
	// active account (`activeUuid` in the `/accounts` response) pre-selects the
	// matching row. When it is absent or unmatched the domain fell back to the
	// first account, so `currentUuid` stays undefined and the button shows the
	// first account's label as a hint (see `labelFor`).
	if (opts.accounts === undefined) {
		// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget initial accounts fetch
		(async (): Promise<void> => {
			try {
				const res = await opts.client.get<{
					ok: boolean;
					accounts: PickerAccount[];
					activeUuid?: string;
				}>("/accounts");
				if (destroyed) {
					return;
				}
				if (res.ok && Array.isArray(res.data.accounts)) {
					({ accounts } = res.data);
					if (currentUuid === undefined && typeof res.data.activeUuid === "string") {
						currentUuid = res.data.activeUuid;
					}
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
