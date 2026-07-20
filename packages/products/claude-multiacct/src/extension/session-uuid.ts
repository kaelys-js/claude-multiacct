/**
 * `@foundation/claude-multiacct` — Code-tab session-uuid extractor.
 *
 * The Code tab (remote `claude.ai`) is a SPA whose URL, DOM attributes, and
 * breadcrumb structure all separately expose the current session uuid. We
 * try each locator in order and take the first that yields a shape valibot
 * accepts as a uuid — a fail-safe fall-through to `undefined` is required so
 * the content script can politely no-op on pages that don't represent a
 * session at all (root, settings, marketing routes).
 *
 * Purity: no `window`, no `document.location` reads, no fs. The caller hands
 * in the location snapshot and the document. This keeps the module testable
 * under jsdom without stubbing globals, and keeps the SPA-navigation caller
 * in `content.ts` in charge of re-invoking after route changes.
 *
 * @module
 */

import * as v from "valibot";
import { AccountUuidSchema } from "../domain/account.ts";

/**
 * Canonical 8-4-4-4-12 hex UUID pattern. Matches inside a longer string so
 * we can pluck one out of a URL path segment.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/**
 * `AccountUuidSchema` is the workspace's validated uuid schema (PR1). We
 * re-use it here as a plain uuid shape-check — the brand is a compile-time
 * concern that the runtime strips, so the same guard suffices for session
 * uuids too. Rule-11: use the schema that exists rather than forking one.
 *
 * @param {string} candidate - The string to test against the uuid schema.
 * @returns {boolean} `true` when `candidate` parses as a valid uuid.
 */
function isValidUuid(candidate: string): boolean {
	return v.safeParse(AccountUuidSchema, candidate).success;
}

/** Minimal location snapshot — matches `Location` without pulling in DOM lib. */
export type LocationSnapshot = {
	pathname: string;
	hash: string;
};

/**
 * Extract the current Code-session uuid from `(location, doc)`.
 *
 * Locator order:
 *   1. URL path segment matching `UUID_RE` (search the whole `pathname` plus
 *      `hash` — SPA routes sometimes stash the session id after `#`).
 *   2. `[data-session-id]` attribute anywhere in the document.
 *   3. Aria-labelled breadcrumb `[data-uuid]`.
 *
 * @param {LocationSnapshot} location - Location snapshot (pathname + hash).
 * @param {Document} doc - Document to scan for DOM-based locators.
 * @returns {string | undefined} The uuid string, or `undefined` when no
 *   locator succeeds.
 */
export function extractSessionUuid(location: LocationSnapshot, doc: Document): string | undefined {
	const haystack = `${location.pathname}${location.hash}`;
	const urlMatch = haystack.match(UUID_RE);
	if (urlMatch !== null && isValidUuid(urlMatch[0])) {
		return urlMatch[0].toLowerCase();
	}

	const attr =
		(doc.querySelector("[data-session-id]") as HTMLElement | null)?.dataset.sessionId ?? "";
	if (attr !== "" && isValidUuid(attr)) {
		return attr.toLowerCase();
	}

	const breadcrumb =
		(doc.querySelector('[aria-label*="session" i] [data-uuid]') as HTMLElement | null)?.dataset
			.uuid ?? "";
	if (breadcrumb !== "" && isValidUuid(breadcrumb)) {
		return breadcrumb.toLowerCase();
	}

	return undefined;
}
