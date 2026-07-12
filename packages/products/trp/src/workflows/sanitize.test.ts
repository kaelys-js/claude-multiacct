// Behavior tests for `sanitize.ts`.
//
// WHY it matters: every parity comparison across the four workflows depends
// on sanitize() producing the exact marker shape the fixture files ship.
// If threshold drifted, short strings would leak into sanitize markers and
// break byte-for-byte parity. If path substitution drifted, `_files_inspected`
// would carry client-repo absolute paths. If the 64-bit fnv1a-64 output
// stopped being 16 hex chars, the `fnv1a-` prefix contract would silently
// mismatch the fixture files.

import { describe, it, expect } from "vitest";
import { SANITIZE_THRESHOLD, fnv1a64, sanitize, stableStringify } from "./sanitize.ts";

describe("fnv1a64", () => {
	it("returns exactly 16 hex chars for any input", () => {
		expect(fnv1a64("")).toHaveLength(16);
		expect(fnv1a64("a")).toHaveLength(16);
		expect(fnv1a64("a".repeat(1000))).toHaveLength(16);
	});

	it("is deterministic across calls", () => {
		expect(fnv1a64("abc")).toBe(fnv1a64("abc"));
	});

	it("produces different hashes for different inputs", () => {
		expect(fnv1a64("abc")).not.toBe(fnv1a64("abd"));
	});

	it("matches the FNV-1a-64 vector for empty string", () => {
		// FNV-1a-64 offset basis in hex.
		expect(fnv1a64("")).toBe("cbf29ce484222325");
	});
});

describe("sanitize — string threshold", () => {
	it("leaves strings up to the threshold untouched", () => {
		const s = "x".repeat(SANITIZE_THRESHOLD);
		expect(sanitize(s)).toBe(s);
	});

	it("replaces strings over the threshold with a marker", () => {
		const s = "x".repeat(SANITIZE_THRESHOLD + 1);
		const out = sanitize(s) as { sanitized: true; len: number; hash: string };
		expect(out.sanitized).toBe(true);
		expect(out.len).toBe(SANITIZE_THRESHOLD + 1);
		expect(out.hash).toMatch(/^fnv1a-[0-9a-f]{16}$/u);
	});
});

describe("sanitize — path substitution", () => {
	it("replaces absolute-path-shaped strings with `<sanitized-path>`", () => {
		expect(sanitize("/Users/x/repo/discovery/task.json")).toBe("<sanitized-path>");
	});

	it("leaves short paths and non-paths alone", () => {
		expect(sanitize("/tmp")).toBe("/tmp");
		expect(sanitize("relative/path/foo.ts")).toBe("relative/path/foo.ts");
	});
});

describe("sanitize — recursion", () => {
	it("walks arrays preserving order", () => {
		const out = sanitize(["short", "y".repeat(50)]) as unknown[];
		expect(out[0]).toBe("short");
		expect((out[1] as { sanitized: true }).sanitized).toBe(true);
	});

	it("walks nested objects preserving key insertion order", () => {
		const input = { a: "z".repeat(50), b: { c: 1 } };
		const out = sanitize(input) as Record<string, unknown>;
		expect(Object.keys(out)).toEqual(["a", "b"]);
		expect((out.a as { sanitized: true }).sanitized).toBe(true);
		expect(out.b).toEqual({ c: 1 });
	});

	it("passes through numbers, booleans, and null", () => {
		expect(sanitize(1)).toBe(1);
		expect(sanitize(true)).toBe(true);
		expect(sanitize(null)).toBeNull();
	});
});

describe("stableStringify", () => {
	it("sorts object keys so byte-for-byte comparison ignores insertion order", () => {
		expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
	});

	it("sorts nested keys recursively", () => {
		const left = stableStringify({ x: { b: 2, a: 1 } });
		const right = stableStringify({ x: { a: 1, b: 2 } });
		expect(left).toBe(right);
	});

	it("preserves array order (arrays are ordered, not sorted)", () => {
		const s = stableStringify([2, 1]);
		expect(s).toBe("[\n  2,\n  1\n]");
	});
});
