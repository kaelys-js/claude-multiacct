/**
 * Intent: the bridge's whole security story is (loopback bind) + (Origin
 * allowlist) + (shared secret). Any one of those going missing collapses
 * the tower. These tests pin each independently so an accidental
 * relaxation goes RED loud:
 *
 *  - Adversarial: remove the Origin check in `validateAuth` → the
 *    "rejects foreign Origin" test flips green→red because the
 *    only-secret world doesn't distinguish a page from claude.ai from
 *    a page from evil.example.com when both know the secret. This is
 *    load-bearing because a stolen bridge.json is a plausible failure
 *    mode (backups, screenshares) and the Origin gate is the second
 *    layer of defense.
 *  - Adversarial: remove the secret check → the "rejects missing
 *    secret" and "rejects wrong secret" cases flip red. Origin alone is
 *    forgeable by any local http client, so this is the actual auth.
 *  - `assertLoopback` throws for anything not in the {127.0.0.1, ::1,
 *    ::ffff:127.0.0.1} triad. A future refactor that binds `0.0.0.0`
 *    would silently expose the daemon; this test is the tripwire.
 */

import { describe, expect, it } from "vitest";
import {
	ALLOWED_ORIGINS,
	assertLoopback,
	BRIDGE_SECRET_HEADER,
	corsPreflight,
	isAllowedOrigin,
	validateAuth,
} from "./security.ts";

describe("assertLoopback", () => {
	it("accepts 127.0.0.1", () => {
		expect(() => assertLoopback("127.0.0.1")).not.toThrow();
	});
	it("accepts ::1", () => {
		expect(() => assertLoopback("::1")).not.toThrow();
	});
	it("accepts ::ffff:127.0.0.1 (v4-mapped v6)", () => {
		expect(() => assertLoopback("::ffff:127.0.0.1")).not.toThrow();
	});
	it("throws for 0.0.0.0 — a mis-bind must fail loud on request 1", () => {
		expect(() => assertLoopback("0.0.0.0")).toThrow(/refusing non-loopback/u);
	});
	it("throws for a LAN address", () => {
		expect(() => assertLoopback("192.168.1.10")).toThrow(/refusing non-loopback/u);
	});
	it("throws for undefined remoteAddress", () => {
		expect(() => assertLoopback(undefined)).toThrow(/refusing non-loopback/u);
	});
});

describe("isAllowedOrigin", () => {
	it("accepts https://claude.ai", () => {
		expect(isAllowedOrigin("https://claude.ai")).toBe(true);
	});
	it("rejects a lookalike (http://claude.ai)", () => {
		expect(isAllowedOrigin("http://claude.ai")).toBe(false);
	});
	it("rejects undefined Origin", () => {
		expect(isAllowedOrigin(undefined)).toBe(false);
	});
	it("ALLOWED_ORIGINS is a single-element list callers can append to", () => {
		expect(ALLOWED_ORIGINS).toEqual(["https://claude.ai"]);
	});
});

describe("corsPreflight", () => {
	it("echoes the allowed origin and lists methods + headers", () => {
		const res = corsPreflight("https://claude.ai");
		expect(res.status).toBe(204);
		expect(res.headers["access-control-allow-origin"]).toBe("https://claude.ai");
		expect(res.headers["access-control-allow-methods"]).toBe("GET,POST,OPTIONS");
		expect(res.headers["access-control-allow-headers"]).toContain(BRIDGE_SECRET_HEADER);
		expect(res.headers["access-control-allow-headers"]).toContain("content-type");
	});
	it("acknowledges Chrome Private Network Access (Chrome 104+) so an HTTPS page can reach 127.0.0.1", () => {
		// Adversarial: drop `access-control-allow-private-network` from
		// corsPreflight and this test flips RED. Without the header, Chrome
		// blocks the fetch as `TypeError: Failed to fetch` and the extension
		// cannot talk to the daemon at all — reproduced live on 2026-07-21.
		const res = corsPreflight("https://claude.ai");
		expect(res.headers["access-control-allow-private-network"]).toBe("true");
	});
});

describe("validateAuth", () => {
	const secret = "abc123";

	it("allows an allowed Origin + matching secret", () => {
		const r = validateAuth({
			origin: "https://claude.ai",
			secretHeader: secret,
			expectedSecret: secret,
		});
		expect(r.ok).toBe(true);
	});

	it("rejects a foreign Origin with 403 (drop the origin check → adversarial RED)", () => {
		const r = validateAuth({
			origin: "https://evil.example.com",
			secretHeader: secret,
			expectedSecret: secret,
		});
		expect(r.ok).toBe(false);
		const failed = r as Extract<typeof r, { ok: false }>;
		expect(failed.status).toBe(403);
		expect(failed.body.reason).toMatch(/origin not allowed/u);
	});

	it("rejects a missing Origin with 403", () => {
		const r = validateAuth({
			origin: undefined,
			secretHeader: secret,
			expectedSecret: secret,
		});
		expect(r.ok).toBe(false);
		const failed = r as Extract<typeof r, { ok: false }>;
		expect(failed.status).toBe(403);
	});

	it("rejects a missing secret header with 401 (drop the secret check → adversarial RED)", () => {
		const r = validateAuth({
			origin: "https://claude.ai",
			secretHeader: undefined,
			expectedSecret: secret,
		});
		expect(r.ok).toBe(false);
		const failed = r as Extract<typeof r, { ok: false }>;
		expect(failed.status).toBe(401);
	});

	it("rejects a wrong secret with 401", () => {
		const r = validateAuth({
			origin: "https://claude.ai",
			secretHeader: "wrong",
			expectedSecret: secret,
		});
		expect(r.ok).toBe(false);
		const failed = r as Extract<typeof r, { ok: false }>;
		expect(failed.status).toBe(401);
	});
});
