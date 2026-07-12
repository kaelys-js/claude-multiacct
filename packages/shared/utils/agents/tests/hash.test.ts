// Behavior tests for `@foundation/agents`'s FNV-1a hash helper.
//
// WHY it matters: prompt_hash and schema_hash live on every agent-request
// journal entry. If fnv1a were non-deterministic, replay diffs would flake.
// If stableStringify did not sort keys, `{ type, properties }` and
// `{ properties, type }` would hash different — a common trap when a schema
// literal is rewritten. If setHashMode("none") did not actually zero the
// output, fixture authors would still have to compute hashes by hand. These
// tests fix each contract.

import { afterEach, describe, expect, it } from "vitest";
import { fnv1a, fnv1aJson, getHashMode, setHashMode } from "../src/hash.ts";

afterEach(() => {
	setHashMode("fnv1a");
});

describe("fnv1a — determinism", () => {
	it("returns the same 8-char hex string for the same input", () => {
		const a = fnv1a("prompt body");
		const b = fnv1a("prompt body");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{8}$/u);
	});

	it("returns different hashes for different inputs", () => {
		expect(fnv1a("prompt body")).not.toBe(fnv1a("prompt body!"));
	});

	it("hashes the empty string to a stable non-empty value", () => {
		const empty = fnv1a("");
		expect(empty).toMatch(/^[0-9a-f]{8}$/u);
	});
});

describe("fnv1aJson — key-order stability", () => {
	it("hashes { type, properties } identically to { properties, type }", () => {
		const a = fnv1aJson({ type: "object", properties: { voice: { type: "string" } } });
		const b = fnv1aJson({ properties: { voice: { type: "string" } }, type: "object" });
		expect(a).toBe(b);
	});

	it("still distinguishes different shapes", () => {
		const a = fnv1aJson({ type: "object", properties: { voice: { type: "string" } } });
		const b = fnv1aJson({ type: "object", properties: { voice: { type: "integer" } } });
		expect(a).not.toBe(b);
	});

	it("hashes arrays element-by-element", () => {
		expect(fnv1aJson([1, 2, 3])).not.toBe(fnv1aJson([3, 2, 1]));
	});
});

describe("setHashMode", () => {
	it("round-trips through getHashMode", () => {
		setHashMode("none");
		expect(getHashMode()).toBe("none");
		setHashMode("fnv1a");
		expect(getHashMode()).toBe("fnv1a");
	});

	it('returns "0" for every input under mode=none so fixture authors do not compute hashes', () => {
		setHashMode("none");
		expect(fnv1a("anything")).toBe("0");
		expect(fnv1a("")).toBe("0");
		expect(fnv1aJson({ type: "object" })).toBe("0");
	});

	it("restores fnv1a hashing when the mode flips back", () => {
		setHashMode("none");
		expect(fnv1a("body")).toBe("0");
		setHashMode("fnv1a");
		expect(fnv1a("body")).toMatch(/^[0-9a-f]{8}$/u);
	});
});
