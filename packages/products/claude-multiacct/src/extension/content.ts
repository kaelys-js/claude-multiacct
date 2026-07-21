/**
 * `@foundation/claude-multiacct` — Code-tab content script entry.
 *
 * The manifest schedules us at `document_idle`, but the Claude Code SPA
 * paints its top bar (the model selector we anchor next to) well after
 * that — we mount lazily via a `MutationObserver` that watches `body` for
 * the anchor to appear. The observer also fires on SPA route changes,
 * which is our re-mount signal: the picker is torn down and rebuilt with
 * the new session uuid whenever the top-bar node is replaced.
 *
 * Every mount is a picker + N usage pills (one per account). `beforeunload`
 * destroys everything so a full-page reload doesn't leak the poll interval.
 *
 * This file is glue only — DOM logic lives in `picker.ts` / `usage.ts` and
 * fetch logic in `bridge-client.ts` / `bridge-config.ts`. Testing focuses
 * on the observer / cleanup lifecycle here; unit tests for each dependency
 * live next to their source.
 *
 * @module
 */

import { createBridgeClient } from "./bridge-client.ts";
import { readBridgeConfig, type FetchLike } from "./bridge-config.ts";
import { mountPicker, type PickerAccount, type PickerHandle } from "./picker.ts";
import { extractSessionUuid, type LocationSnapshot } from "./session-uuid.ts";
import { mountUsage, type UsageHandle } from "./usage.ts";

/** Anchor selectors — tried in order, first match wins. */
const ANCHOR_SELECTORS: readonly string[] = [
	'[data-testid*="model" i]',
	'button[aria-label*="model" i]',
	'header [role="combobox"]',
];

/**
 * Regex matching Claude's model-selector button by its rendered text
 * (`Opus 4.7`, `Sonnet 4.5`, `Haiku 4.5`, etc.). Load-bearing because
 * Claude's real button has no `data-testid`, no `aria-label`, no `role`,
 * and its `id` is a dynamic base-ui slug (`base-ui-_r_li_`) — none of the
 * attribute selectors above match. Live-verified 2026-07-21 on the
 * Code-tab bottom bar. Text-content matching is brittle to a rename
 * ("Foo" → "Opus 5") but survives class/id churn, which is the more
 * frequent change vector for a hot product.
 */
const MODEL_FAMILY_TEXT_RE = /^(Opus|Sonnet|Haiku)\s/iu;

function findAnchor(doc: Document): Element | undefined {
	for (const sel of ANCHOR_SELECTORS) {
		const el = doc.querySelector(sel);
		if (el !== null) {
			return el;
		}
	}
	// Text-content fallback: iterate every button and match on its text.
	// Uses NodeList iteration rather than querySelectorAll+Array.from so it
	// short-circuits at the first hit (typically <20 buttons in Claude's
	// Code-tab shell before the model selector).
	for (const btn of doc.querySelectorAll("button")) {
		const text = btn.textContent?.trim() ?? "";
		if (MODEL_FAMILY_TEXT_RE.test(text)) {
			return btn;
		}
	}
	return undefined;
}

export type ContentDeps = {
	doc: Document;
	win: Window;
	fetchImpl: (url: string, init?: unknown) => Promise<unknown>;
	extensionUrl: (path: string) => string;
};

/**
 * Boot the content script against the injected deps.
 *
 * @param {ContentDeps} deps - Injected doc/win/fetch/extensionUrl.
 * @returns {Promise<{destroy(): void} | undefined>} A cleanup handle, or
 *   `undefined` when the bridge is unavailable (deployment without daemon).
 */
export async function bootContent(deps: ContentDeps): Promise<{ destroy(): void } | undefined> {
	// Inert diagnostic marker — lets an operator confirm from devtools that the
	// script actually reached execution (vs a matches / injection failure that
	// looks identical from the picker-missing symptom).
	deps.doc.documentElement.dataset.cmaContent = "loaded";
	// eslint-disable-next-line no-console
	console.log(
		"[cma-content] executed at",
		deps.win.location.href,
		"readyState=",
		deps.doc.readyState,
	);
	const config = await readBridgeConfig(deps.fetchImpl as unknown as FetchLike, deps.extensionUrl);
	if (config === undefined) {
		return undefined;
	}
	const client = createBridgeClient({
		fetchImpl: deps.fetchImpl as never,
		extensionUrl: deps.extensionUrl,
		config,
	});

	let picker: PickerHandle | undefined;
	let usageAugmenter: UsageHandle | undefined;
	let accounts: PickerAccount[] = [];

	async function loadAccounts(): Promise<void> {
		const res = await client.get<{ ok: boolean; accounts: PickerAccount[] }>("/accounts");
		if (res.ok && Array.isArray(res.data.accounts)) {
			({ accounts } = res.data);
		}
	}

	function locationSnapshot(): LocationSnapshot {
		return { pathname: deps.win.location.pathname, hash: deps.win.location.hash };
	}

	function tearDown(): void {
		picker?.destroy();
		picker = undefined;
		usageAugmenter?.destroy();
		usageAugmenter = undefined;
	}

	function mountAt(anchor: Element): void {
		const sessionUuid = extractSessionUuid(locationSnapshot(), deps.doc);
		// Usage augmenter first so `notifyActive` is wired before the picker
		// can fire its onChoice.
		usageAugmenter = mountUsage({
			doc: deps.doc,
			client,
			accounts,
		});
		picker = mountPicker({
			/* c8 ignore next -- attached DOM nodes always have a parent; guard is defensive. */
			host: anchor.parentElement ?? anchor,
			client,
			sessionUuid,
			doc: deps.doc,
			accounts,
			onChoice: (uuid) => {
				usageAugmenter?.notifyActive(uuid);
			},
		});
		// Pick the initial active account (mirror picker's default: primary).
		usageAugmenter.notifyActive(picker.currentUuid());
	}

	await loadAccounts();

	const MO = (deps.win as unknown as { MutationObserver: typeof MutationObserver })
		.MutationObserver;
	const observer = new MO(() => {
		const anchor = findAnchor(deps.doc);
		if (anchor === undefined) {
			return;
		}
		// If picker already mounted next to this anchor, no-op.
		/* c8 ignore next -- attached anchor always has a parent; guard is defensive. */
		const already = (anchor.parentElement ?? anchor).querySelector("[data-cma-picker]");
		if (already !== null) {
			return;
		}
		tearDown();
		mountAt(anchor);
	});
	// `attributes` on the observer is load-bearing: Claude's top-bar hydrates
	// its model-selector attributes onto an already-mounted node rather than
	// swapping the node itself, so a childList-only observer never re-fires
	// and the picker stays absent (Rule 12: silent no-mount is the exact
	// failure this guards against). Filter to the three attributes findAnchor
	// keys off so an active SPA doesn't wake the callback on every unrelated
	// aria-toggle.
	observer.observe(deps.doc.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["data-testid", "aria-label", "role"],
	});

	// Initial pass in case the anchor already exists at boot.
	const anchor = findAnchor(deps.doc);
	if (anchor !== undefined) {
		mountAt(anchor);
	}

	const onBeforeUnload = (): void => {
		observer.disconnect();
		tearDown();
	};
	deps.win.addEventListener("beforeunload", onBeforeUnload);

	return {
		destroy(): void {
			deps.win.removeEventListener("beforeunload", onBeforeUnload);
			observer.disconnect();
			tearDown();
		},
	};
}

/* c8 ignore start -- IIFE entry runs inside a real browser only; the boot
   function above is what tests exercise. */
declare const chrome: { runtime: { getURL(path: string): string } };
if (typeof window !== "undefined" && typeof document !== "undefined") {
	// Guarded by a runtime browser-context check, so this can't be genuine
	// top-level await.
	// eslint-disable-next-line unicorn/prefer-top-level-await, eslint/no-void
	void (async (): Promise<void> => {
		try {
			await bootContent({
				doc: document,
				win: window,
				fetchImpl: (url, init) => fetch(url, init as RequestInit),
				extensionUrl: (path: string) => chrome.runtime.getURL(path),
			});
		} catch (error) {
			// eslint-disable-next-line no-console
			console.warn("[cma-extension] boot failed:", error);
		}
	})();
}
/* c8 ignore stop */
