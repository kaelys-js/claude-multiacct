/**
 * Intent: prove that `extractSessionUuid` finds the current session id from
 * whichever locator the Code SPA happens to expose today, and returns
 * `undefined` on marketing/settings routes where none is present. The
 * fallback to `undefined` is what lets `content.ts` stay silent on pages
 * that aren't a session. Adversarial: drop the hex-group anchors in the
 * regex to hex-only (no dashes) and the URL locator stops recognising
 * a real uuid.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractSessionUuid } from "./session-uuid.ts";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const UUID_UPPER = UUID.toUpperCase();

function docWith(html: string): Document {
	return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

describe("extractSessionUuid", () => {
	it("finds a uuid embedded in the URL path", () => {
		expect(extractSessionUuid({ pathname: `/chat/${UUID}`, hash: "" }, docWith(""))).toBe(UUID);
	});

	it("finds a uuid in the URL hash (SPA fragment routes)", () => {
		expect(extractSessionUuid({ pathname: "/chat", hash: `#s/${UUID}` }, docWith(""))).toBe(UUID);
	});

	it("lowercases URL-uppercase uuids so downstream comparisons are stable", () => {
		expect(extractSessionUuid({ pathname: `/chat/${UUID_UPPER}`, hash: "" }, docWith(""))).toBe(
			UUID,
		);
	});

	it("falls back to the [data-session-id] attribute", () => {
		const doc = docWith(`<div data-session-id="${UUID}"></div>`);
		expect(extractSessionUuid({ pathname: "/", hash: "" }, doc)).toBe(UUID);
	});

	it("falls back to the breadcrumb [data-uuid] descendant", () => {
		const doc = docWith(
			`<nav aria-label="Current session"><span data-uuid="${UUID}"></span></nav>`,
		);
		expect(extractSessionUuid({ pathname: "/", hash: "" }, doc)).toBe(UUID);
	});

	it("returns undefined when no locator matches", () => {
		expect(extractSessionUuid({ pathname: "/settings", hash: "" }, docWith(""))).toBeUndefined();
	});

	it("rejects a plausibly-shaped but non-uuid string in the DOM (guards against false positives)", () => {
		const bad = "not-a-real-uuid-just-some-text-in-the-attr";
		const doc = docWith(`<div data-session-id="${bad}"></div>`);
		expect(extractSessionUuid({ pathname: "/", hash: "" }, doc)).toBeUndefined();
	});

	it("prefers the URL match over DOM locators when both are present", () => {
		const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const doc = docWith(`<div data-session-id="${other}"></div>`);
		expect(extractSessionUuid({ pathname: `/chat/${UUID}`, hash: "" }, doc)).toBe(UUID);
	});
});
