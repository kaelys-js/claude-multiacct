/**
 * `@foundation/claude-multiacct` — user-menu augmenter (per-account usage).
 *
 * Instead of pinning separate "usage pill" spans next to the model
 * selector (that read as broken chrome), this watches for Claude's
 * existing user-menu popup — the one anchored to `.df-user-menu-btn`
 * and identified by its child `[data-testid="user-menu-header"]` — and
 * prepends an "Account" section right under the header. Each row shows
 * one pooled account, its current usage percentage, and a checkmark on
 * the active one. The row is a real menuitem so keyboard nav + hover
 * highlight work the same as Claude's own items.
 *
 * Auto-updates on account switch: `content.ts` calls `notifyActive(uuid)`
 * whenever the picker fires `onChoice`, and we re-render if the menu is
 * currently open.
 *
 * @module
 */

import type { BridgeClient } from "./bridge-client.ts";
import type { PickerAccount } from "./picker.ts";

export type UsageMountOptions = {
	doc: Document;
	client: BridgeClient;
	accounts: PickerAccount[];
	/** Poll interval override for tests. Default 60_000 ms. */
	intervalMs?: number;
	/** Setter shim; tests inject fake timers. Defaults to global. */
	setInterval?: (fn: () => void, ms: number) => number;
	/** Clearer shim; tests inject fake timers. Defaults to global. */
	clearInterval?: (handle: number) => void;
	/** Called by the augmenter when the user picks an account row (rare — the picker button is the main entry). */
	onSwitch?: (accountUuid: string) => void;
};

export type UsageHandle = {
	destroy(): void;
	/** Called by content.ts after the picker fires onChoice — updates the checkmark if the menu is open. */
	notifyActive(uuid: string | undefined): void;
};

type UsageApiPayload = {
	ok: boolean;
	verify?: {
		subscription?: string;
		tier?: string;
		remainingRatio?: number | "unknown";
		resetAt?: string;
	};
};

type UsageState = {
	subscription?: string;
	tier?: string;
	remainingRatio?: number | "unknown";
	resetAt?: string;
};

const SECTION_MARKER = "data-cma-user-menu-section";
const OBSERVE_INIT: MutationObserverInit = { childList: true, subtree: true };
const HEADER_CLASSES =
	"compact:px-2 comfortable:px-2.5 py-1 text-footnote font-medium text-muted truncate";
const ITEM_CLASSES =
	"cds-reset flex w-full items-center gap-xs compact:px-2 comfortable:px-2.5 py-[calc((var(--cds-h-control)-var(--cds-leading-body))/2)] rounded text-body select-none outline-none text-primary hover:bg-fill-ghost-hover cursor-default";

function relativeTime(now: number, iso: string | undefined): string {
	if (iso === undefined) {
		return "";
	}
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const deltaSec = Math.round((then - now) / 1000);
	if (deltaSec <= 0) {
		return "now";
	}
	if (deltaSec < 3600) {
		return `${String(Math.round(deltaSec / 60))}m`;
	}
	if (deltaSec < 86_400) {
		return `${String(Math.round(deltaSec / 3600))}h`;
	}
	return `${String(Math.round(deltaSec / 86_400))}d`;
}

function ratioLabel(u: UsageState | undefined): string {
	if (u === undefined) {
		return "";
	}
	if (u.remainingRatio === undefined || u.remainingRatio === "unknown") {
		return "";
	}
	return `${String(Math.round(u.remainingRatio * 100))}% left`;
}

/**
 * Watch for Claude's user menu popup and inject an "Account" section.
 *
 * @param {UsageMountOptions} opts - Doc, client, account list.
 * @returns {UsageHandle} `{destroy, notifyActive}`.
 */
export function mountUsage(opts: UsageMountOptions): UsageHandle {
	const setIv =
		opts.setInterval ??
		((fn: () => void, ms: number): number => setInterval(fn, ms) as unknown as number);
	const clearIv =
		opts.clearInterval ??
		((h: number): void => clearInterval(h as unknown as ReturnType<typeof setInterval>));
	const interval = opts.intervalMs ?? 60_000;

	const usageByAccount = new Map<string, UsageState>();
	// No stored primary: seed the active account with the first in pool order,
	// mirroring the domain's runtime active-account fallback.
	let activeUuid: string | undefined = opts.accounts[0]?.uuid;
	let destroyed = false;
	let pollHandle: number | undefined;

	async function fetchOne(uuid: string): Promise<void> {
		try {
			const res = await opts.client.get<UsageApiPayload>(`/usage/${uuid}`);
			if (destroyed) {
				return;
			}
			if (!res.ok || res.data.verify === undefined) {
				usageByAccount.set(uuid, {});
			} else {
				usageByAccount.set(uuid, {
					subscription: res.data.verify.subscription,
					tier: res.data.verify.tier,
					remainingRatio: res.data.verify.remainingRatio,
					resetAt: res.data.verify.resetAt,
				});
			}
			renderIfOpen();
		} catch {
			// Swallow — a failed fetch just leaves the row without usage info.
		}
	}

	async function fetchAll(): Promise<void> {
		await Promise.all(opts.accounts.map((a) => fetchOne(a.uuid)));
	}

	function detailLabel(u: UsageState | undefined): string {
		if (u === undefined) {
			return "";
		}
		const parts: string[] = [];
		const ratio = ratioLabel(u);
		if (ratio !== "") {
			parts.push(ratio);
		}
		const reset = relativeTime(Date.now(), u.resetAt);
		if (reset !== "" && reset !== "now") {
			parts.push(`resets in ${reset}`);
		}
		return parts.join(" · ");
	}

	function findOpenMenu(): Element | undefined {
		const header = opts.doc.querySelector('[data-testid="user-menu-header"]');
		const menu = header?.closest('[role="menu"]');
		return menu ?? undefined;
	}

	function ensureSection(menu: Element): HTMLElement {
		const existing = menu.querySelector<HTMLElement>(`[${SECTION_MARKER}]`);
		if (existing !== null) {
			return existing;
		}
		const container = opts.doc.createElement("div");
		container.setAttribute(SECTION_MARKER, "");
		container.className = HEADER_CLASSES; // best-effort utility hint
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.padding = "0";
		container.style.marginTop = "4px";
		// Add a subtle divider ABOVE our section so it visually separates
		// from Claude's own header row.
		container.style.borderTop = "1px solid rgba(255, 255, 255, 0.08)";
		container.style.paddingTop = "4px";

		const header = opts.doc.createElement("div");
		header.setAttribute("role", "presentation");
		header.className = HEADER_CLASSES;
		header.style.padding = "6px 10px 4px";
		header.style.fontSize = "11px";
		header.style.fontWeight = "600";
		header.style.opacity = "0.55";
		header.textContent = "Account";
		container.append(header);

		const menuHeader = menu.querySelector('[data-testid="user-menu-header"]');
		if (menuHeader?.parentElement !== undefined && menuHeader.parentElement !== null) {
			menuHeader.parentElement.insertBefore(container, menuHeader.nextSibling);
		} else {
			menu.append(container);
		}
		return container;
	}

	function renderSection(container: HTMLElement): void {
		// Clear items but keep the "Account" header (first child).
		while (container.children.length > 1) {
			const last = container.lastElementChild;
			if (last === null) {
				break;
			}
			last.remove();
		}
		for (const account of opts.accounts) {
			const isActive = account.uuid === activeUuid;
			const row = opts.doc.createElement("div");
			row.setAttribute("role", "menuitem");
			row.setAttribute("tabindex", "-1");
			row.dataset.cmaAccountUuid = account.uuid;
			row.className = ITEM_CLASSES;
			row.style.display = "flex";
			row.style.alignItems = "center";
			row.style.gap = "8px";
			row.style.padding = "6px 10px";
			row.style.borderRadius = "6px";
			row.style.cursor = "default";
			row.style.userSelect = "none";
			row.style.fontSize = "13px";
			row.style.background = isActive ? "rgba(255, 255, 255, 0.06)" : "transparent";
			row.addEventListener("mouseenter", () => {
				if (!isActive) {
					row.style.background = "rgba(255, 255, 255, 0.08)";
				}
			});
			row.addEventListener("mouseleave", () => {
				row.style.background = isActive ? "rgba(255, 255, 255, 0.06)" : "transparent";
			});

			const check = opts.doc.createElement("span");
			check.style.display = "inline-flex";
			check.style.width = "14px";
			check.style.justifyContent = "center";
			check.style.opacity = "0.85";
			check.textContent = isActive ? "✓" : "";
			row.append(check);

			const label = opts.doc.createElement("span");
			label.style.flex = "1 1 auto";
			label.style.minWidth = "0";
			label.style.overflow = "hidden";
			label.style.textOverflow = "ellipsis";
			label.style.whiteSpace = "nowrap";
			label.textContent = account.label;
			row.append(label);

			const detail = detailLabel(usageByAccount.get(account.uuid));
			if (detail !== "") {
				const detailEl = opts.doc.createElement("span");
				detailEl.style.marginLeft = "8px";
				detailEl.style.fontSize = "11px";
				detailEl.style.opacity = "0.6";
				detailEl.textContent = detail;
				row.append(detailEl);
			}

			row.addEventListener("click", (event: Event) => {
				event.stopPropagation();
				opts.onSwitch?.(account.uuid);
			});
			container.append(row);
		}
	}

	function renderIfOpen(): void {
		const menu = findOpenMenu();
		if (menu === undefined) {
			return;
		}
		// renderSection mutates the observed subtree (clears + re-adds rows).
		// Pause the observer around the write so its callback does not fire on
		// our own mutations — otherwise every render schedules another render
		// through the observer and JSDOM spins forever. `takeRecords()` drops
		// the queued records from the write we just performed so re-attaching
		// does not re-trigger us on the next microtask.
		observer.disconnect();
		try {
			const section = ensureSection(menu);
			renderSection(section);
		} finally {
			observer.takeRecords();
			observer.observe(opts.doc.body, OBSERVE_INIT);
		}
	}

	// Watch the document for the user menu appearing (Base UI mounts it via portal).
	// Use the injected doc's window's MutationObserver so JSDOM tests work
	// without polluting globals.
	const MO = (
		opts.doc.defaultView ?? (globalThis as unknown as { MutationObserver: typeof MutationObserver })
	).MutationObserver;
	const observer = new MO(() => {
		renderIfOpen();
	});
	observer.observe(opts.doc.body, OBSERVE_INIT);

	// Prime immediately in case the menu happens to already be open.
	renderIfOpen();
	// Prime usage data. Fire-and-forget — a failed prime just leaves rows
	// without usage numbers; render() renders anyway.
	// eslint-disable-next-line typescript/no-floating-promises -- Intentionally fire-and-forget; failure swallowed inside fetchOne.
	(async (): Promise<void> => {
		try {
			await fetchAll();
		} catch {
			// Swallowed — logged by fetchOne's own catch.
		}
	})();

	function startPolling(): void {
		if (pollHandle !== undefined) {
			return;
		}
		pollHandle = setIv(() => {
			// eslint-disable-next-line typescript/no-floating-promises -- Intentionally fire-and-forget poll tick.
			(async (): Promise<void> => {
				try {
					await fetchAll();
				} catch {
					// Swallowed.
				}
			})();
		}, interval);
	}

	function stopPolling(): void {
		if (pollHandle !== undefined) {
			clearIv(pollHandle);
			pollHandle = undefined;
		}
	}

	function onVisibility(): void {
		if (opts.doc.visibilityState === "visible") {
			startPolling();
		} else {
			stopPolling();
		}
	}
	opts.doc.addEventListener("visibilitychange", onVisibility);
	if (opts.doc.visibilityState === "visible") {
		startPolling();
	}

	return {
		destroy(): void {
			destroyed = true;
			stopPolling();
			observer.disconnect();
			opts.doc.removeEventListener("visibilitychange", onVisibility);
			// Clean up any injected section.
			for (const s of opts.doc.querySelectorAll(`[${SECTION_MARKER}]`)) {
				s.remove();
			}
		},
		notifyActive(uuid: string | undefined): void {
			activeUuid = uuid;
			renderIfOpen();
		},
	};
}
