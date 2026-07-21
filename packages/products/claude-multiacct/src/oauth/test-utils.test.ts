/* oxlint-disable vitest/require-to-throw-message */
/**
 * Intent: assertOk / assertNotOk narrow union types so downstream tests can
 * skip conditional narrowing (which oxlint's vitest plugin rejects). These
 * micro-tests pin both branches so the shared helper does not silently
 * regress.
 */

import { describe, expect, it } from "vitest";
import { assertNotOk, assertOk } from "./test-utils.ts";

describe("assertOk", () => {
	it("returns silently on ok:true", () => {
		expect(() => {
			assertOk({ ok: true });
		}).not.toThrow();
	});
	it("throws on ok:false", () => {
		expect(() => {
			assertOk({ ok: false, kind: "x" });
		}).toThrow();
	});
});

describe("assertNotOk", () => {
	it("returns silently on ok:false", () => {
		expect(() => {
			assertNotOk({ ok: false });
		}).not.toThrow();
	});
	it("throws on ok:true", () => {
		expect(() => {
			assertNotOk({ ok: true });
		}).toThrow();
	});
});
