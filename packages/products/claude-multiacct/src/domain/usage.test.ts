/**
 * Intent: `UsageSnapshot` must distinguish "quota reading is 0" from "reading
 * unavailable", because the router uses the difference to decide whether to
 * skip or use an account. The tests below pin (a) the literal `"unknown"` is a
 * representable value, (b) numeric readings outside `[0, 1]` are rejected, and
 * (c) `strictObject` blocks a future API adding a field the router would then
 * misinterpret.
 */

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { RemainingRatioSchema, UsageSnapshotSchema } from "./usage.ts";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const validSnapshot = {
	accountUuid: ACCOUNT,
	remainingRatio: 0.42,
	tier: "tier-2",
	resetAt: "2026-07-19T12:00:00.000Z",
};

describe("RemainingRatioSchema", () => {
	it("accepts values inside [0, 1]", () => {
		expect(v.parse(RemainingRatioSchema, 0)).toBe(0);
		expect(v.parse(RemainingRatioSchema, 0.5)).toBe(0.5);
		expect(v.parse(RemainingRatioSchema, 1)).toBe(1);
	});

	it('accepts the literal "unknown" — the load-bearing "no reading" state', () => {
		expect(v.parse(RemainingRatioSchema, "unknown")).toBe("unknown");
	});

	it("rejects a negative ratio (adversarial: would flip skip logic)", () => {
		expect(() => v.parse(RemainingRatioSchema, -0.01)).toThrow(v.ValiError);
	});

	it("rejects a ratio > 1 (adversarial: quota-miscount API bug must not propagate)", () => {
		expect(() => v.parse(RemainingRatioSchema, 1.5)).toThrow(v.ValiError);
	});

	it('rejects an arbitrary string other than "unknown"', () => {
		expect(() => v.parse(RemainingRatioSchema, "n/a")).toThrow(v.ValiError);
	});
});

describe("UsageSnapshotSchema", () => {
	it("accepts a well-formed numeric snapshot", () => {
		expect(v.parse(UsageSnapshotSchema, validSnapshot)).toStrictEqual(validSnapshot);
	});

	it('accepts a snapshot with remainingRatio: "unknown"', () => {
		const s = { ...validSnapshot, remainingRatio: "unknown" };
		expect(v.parse(UsageSnapshotSchema, s)).toStrictEqual(s);
	});

	it("rejects a malformed accountUuid", () => {
		expect(() => v.parse(UsageSnapshotSchema, { ...validSnapshot, accountUuid: "abc" })).toThrow(
			v.ValiError,
		);
	});

	it("rejects an empty tier", () => {
		expect(() => v.parse(UsageSnapshotSchema, { ...validSnapshot, tier: "" })).toThrow(v.ValiError);
	});

	it("rejects a malformed resetAt", () => {
		expect(() => v.parse(UsageSnapshotSchema, { ...validSnapshot, resetAt: "soon" })).toThrow(
			v.ValiError,
		);
	});

	it("rejects an unknown extra key — strictObject (future API field must fail loud)", () => {
		expect(() => v.parse(UsageSnapshotSchema, { ...validSnapshot, projected: 0.1 })).toThrow(
			v.ValiError,
		);
	});
});
