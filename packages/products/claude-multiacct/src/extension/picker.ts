/**
 * `@foundation/claude-multiacct` — account picker (light DOM, Claude-styled).
 *
 * Renders a button next to Claude's model selector in the Code-tab bottom
 * bar, and a dropdown menu positioned above it. Light DOM (no shadow) so the
 * menu can reach the page's own theme variables and match Claude's native
 * dropdown pixel-for-pixel.
 *
 * The menu also carries pool management: each account row has a small remove
 * control (`DELETE /accounts/:uuid`), and a trailing "+ Add account" row runs a
 * real in-app OAuth sign-in — it asks the daemon to start a login
 * (`POST /accounts/login/start`), opens the returned Anthropic authorize URL in
 * the browser, shows an in-DOM "signing in…" state, and polls
 * `GET /accounts/login/status/:loginId` until the account registers. Electron's
 * renderer has NO `window.prompt`, so there is no prompt-a-token path; an
 * explicit in-DOM token-paste form (`POST /accounts`) is offered as a fallback.
 * Every success re-fetches `/accounts` so the menu reflects the new pool without
 * a page reload.
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
	 * removed, so its row shows a disabled × with an explanatory tooltip. Absent
	 * is treated as `explicit` (removable), mirroring the domain's default.
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
	 * Open the Anthropic authorize URL in the user's browser. Defaults to the
	 * document view's `window.open(url, "_blank", "noopener")`. Injected so tests
	 * never open a real browser window and can assert the exact URL.
	 */
	openUrl?: (url: string) => void;
	/**
	 * Sleep between login-status polls. Defaults to a real `setTimeout`. Injected
	 * so tests drive the poll loop deterministically without wall-clock waits.
	 */
	sleep?: (ms: number) => Promise<void>;
	/** Poll interval while waiting for the browser sign-in (default 1500ms). */
	pollIntervalMs?: number;
	/** Give up waiting for sign-in after this long (default 5 minutes). */
	pollTimeoutMs?: number;
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

	// Browser + dialog ports. Default to the document view's own
	// `window.open`/`window.confirm` (the content script always has a view);
	// tests inject fakes. `defaultView` is non-null for both the extension
	// document and jsdom, so the cast spends no runtime branch on the null case.
	//
	// There is NO `window.prompt` here: Electron's renderer has no `prompt`, so
	// the old prompt-a-token add path was a silent no-op. Adding an account now
	// runs a real OAuth sign-in (see `startLogin`), with an in-DOM token-paste
	// form as an explicit fallback (see `renderTokenForm`).
	const view = doc.defaultView as Window & typeof globalThis;
	function defaultOpenUrl(url: string): void {
		view.open(url, "_blank", "noopener");
	}
	function defaultConfirm(message: string): boolean {
		return view.confirm(message);
	}
	function defaultSleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			view.setTimeout(resolve, ms);
		});
	}
	const openUrlFn = opts.openUrl ?? defaultOpenUrl;
	const confirmFn = opts.confirm ?? defaultConfirm;
	const sleepFn = opts.sleep ?? defaultSleep;
	const pollIntervalMs = opts.pollIntervalMs ?? 1500;
	const pollTimeoutMs = opts.pollTimeoutMs ?? 300_000;

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
	// Add-account area state. `waiting` while the browser sign-in is in flight;
	// `error` shows `addMessage`; `tokenFormOpen` reveals the paste fallback.
	let addState: "idle" | "waiting" | "error" = "idle";
	let addMessage = "";
	let tokenFormOpen = false;
	let activeLoginId: string | undefined;
	// The authorize URL of the in-flight login, surfaced as a clickable link in
	// the waiting state so the user always has a reliable way to open it.
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

			const removeBtn = doc.createElement("button");
			removeBtn.type = "button";
			removeBtn.className = "cds-reset";
			removeBtn.textContent = "×";
			styleRemoveButton(removeBtn);
			if (account.source === "native") {
				// The native account is the pool anchor Claude.app is signed into;
				// the daemon refuses to remove it (409), so the row shows a disabled
				// × with a tooltip rather than an actionable control that only errors.
				removeBtn.dataset.cmaRemoveDisabled = account.uuid;
				removeBtn.disabled = true;
				removeBtn.setAttribute(
					"aria-label",
					`${account.label} is the primary account and can't be removed`,
				);
				removeBtn.title = "Primary account — signed into Claude.app, can't be removed";
				removeBtn.style.opacity = "0.3";
				removeBtn.style.cursor = "not-allowed";
				// Swallow clicks so a stray press never bubbles to the row's choose.
				removeBtn.addEventListener("click", (event: Event) => event.stopPropagation());
			} else {
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
			}
			item.append(removeBtn);

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

	// The add-account area. Three visual states: idle (the "+ Add account"
	// OAuth entry plus the token-paste fallback toggle), waiting (a live
	// "signing in…" line with a cancel control), and error (an inline message
	// above the idle entries). Rendered fresh on every `renderItems`.
	function renderAddArea(): void {
		if (addState === "waiting") {
			inner.append(
				statusRow("cmaLoginWaiting", addMessage || "Signing in… complete it in your browser"),
			);
			// A real anchor to the authorize URL. `openUrl` (window.open) is fired
			// automatically on start, but Electron can restrict programmatic opens
			// (window.prompt is a no-op here, so window.open might be too). A user
			// click on a genuine <a target="_blank"> is the reliable external-open
			// path the host app always honors — the guaranteed fallback.
			if (activeAuthorizeUrl !== undefined) {
				const link = doc.createElement("a");
				link.dataset.cmaLoginLink = "";
				link.href = activeAuthorizeUrl;
				link.target = "_blank";
				link.rel = "noopener";
				link.textContent = "Open the sign-in page";
				link.style.display = "block";
				link.style.padding = "6px 10px";
				link.style.color = "var(--claude-text-100, #f5f4ef)";
				link.style.textDecoration = "underline";
				link.style.cursor = "pointer";
				link.addEventListener("click", (event: Event) => event.stopPropagation());
				inner.append(link);
			}
			inner.append(
				actionRow("cmaLoginCancel", "Cancel sign-in", () => {
					// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget click handler
					(async (): Promise<void> => {
						await cancelLogin();
					})();
				}),
			);
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
						addMessage = "Could not start sign-in.";
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
					addState = "idle";
					renderItems();
					positionMenu();
				}),
			);
		}
	}

	// Explicit fallback: an in-DOM token-paste form (Electron has no
	// window.prompt, so the collector must be real DOM). Label + token inputs
	// POST straight to /accounts, the same provisioning path the OAuth flow ends
	// in. This is a fallback IN ADDITION to the OAuth login, never instead of it.
	function renderTokenForm(): void {
		const form = doc.createElement("div");
		form.dataset.cmaTokenForm = "";
		form.style.display = "flex";
		form.style.flexDirection = "column";
		form.style.gap = "4px";
		form.style.padding = "6px 10px";

		const labelInput = doc.createElement("input");
		labelInput.dataset.cmaTokenLabel = "";
		labelInput.type = "text";
		labelInput.placeholder = "Label (optional)";
		labelInput.style.width = "100%";
		labelInput.style.boxSizing = "border-box";

		const tokenInput = doc.createElement("input");
		tokenInput.dataset.cmaTokenInput = "";
		tokenInput.type = "password";
		tokenInput.placeholder = "Paste OAuth token";
		tokenInput.style.width = "100%";
		tokenInput.style.boxSizing = "border-box";

		const submit = doc.createElement("button");
		submit.type = "button";
		submit.dataset.cmaTokenSubmit = "";
		submit.className = "cds-reset";
		submit.textContent = "Add";
		submit.addEventListener("click", (event: Event) => {
			event.stopPropagation();
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget click handler
			(async (): Promise<void> => {
				await submitToken(labelInput.value, tokenInput.value);
			})();
		});

		// Clicks inside the form must not bubble to the outside-close handler.
		form.addEventListener("click", (event: Event) => event.stopPropagation());
		form.append(labelInput, tokenInput, submit);
		inner.append(form);
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

	// "+ Add account" — start a real OAuth sign-in. Ask the daemon to bind a
	// loopback listener + build the authorize URL, open that URL in the browser,
	// then poll the daemon until the sign-in completes and refresh the pool.
	async function startLogin(): Promise<void> {
		type StartData = { ok: boolean; loginId?: string; authorizeUrl?: string };
		const started: BridgeResult<StartData> = await opts.client.post("/accounts/login/start", {});
		if (
			!started.ok ||
			typeof started.data.loginId !== "string" ||
			typeof started.data.authorizeUrl !== "string"
		) {
			addState = "error";
			addMessage = "Could not start sign-in. Is the pool feature enabled?";
			renderItems();
			return;
		}
		activeLoginId = started.data.loginId;
		activeAuthorizeUrl = started.data.authorizeUrl;
		addState = "waiting";
		addMessage = "Signing in… complete it in your browser";
		tokenFormOpen = false;
		renderItems();
		positionMenu();
		openUrlFn(started.data.authorizeUrl);
		await pollLogin(started.data.loginId);
	}

	// Poll the login's status until it leaves `pending`/`exchanging`, the caller
	// cancels (activeLoginId cleared), the picker is destroyed, or the deadline
	// passes. On `done` refresh the pool; on `error`/`cancelled` surface it.
	async function pollLogin(loginId: string): Promise<void> {
		type StatusData = { ok: boolean; status?: string; detail?: string };
		const deadline = Date.now() + pollTimeoutMs;
		while (Date.now() < deadline) {
			// eslint-disable-next-line no-await-in-loop -- polling is sequential by design: wait, check, repeat
			await sleepFn(pollIntervalMs);
			if (destroyed || activeLoginId !== loginId) {
				return;
			}
			// eslint-disable-next-line no-await-in-loop -- one status probe per interval; must be serial
			const res: BridgeResult<StatusData> = await opts.client.get(
				`/accounts/login/status/${loginId}`,
			);
			if (!res.ok) {
				addState = "error";
				addMessage = "Lost contact with the sign-in.";
				activeLoginId = undefined;
				renderItems();
				return;
			}
			const { status } = res.data;
			if (status === "done") {
				activeLoginId = undefined;
				addState = "idle";
				addMessage = "";
				// eslint-disable-next-line no-await-in-loop -- terminal branch; loop exits right after
				await refetchAccounts();
				return;
			}
			if (status === "error" || status === "cancelled") {
				activeLoginId = undefined;
				addState = "error";
				addMessage = res.data.detail ?? `Sign-in ${status}.`;
				renderItems();
				return;
			}
		}
		// Deadline passed with no terminal status.
		addState = "error";
		addMessage = "Sign-in timed out.";
		activeLoginId = undefined;
		renderItems();
	}

	// Cancel a pending sign-in: tell the daemon to close its listener, then
	// return the add area to idle. Clearing `activeLoginId` stops any live poll.
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
			addMessage = "Token was rejected.";
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
