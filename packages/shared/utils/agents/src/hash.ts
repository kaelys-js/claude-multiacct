/**
 * `@foundation/agents` — 8-hex-char hash for drift detection.
 *
 * Every agent() call stamps `prompt_hash` and `schema_hash` on the
 * agent-request JournalEntry. During replay, a mismatch on either hash means
 * the workflow's prompt template or schema literal drifted from the recording
 * — the replay Host does not automatically fail, but the assertion in the
 * fixture test does, so the diagnostic surfaces loud (Rule 12).
 *
 * SHA-256 truncated to 8 hex chars (32-bit space) chosen for three reasons: it
 * uses Node's built-in crypto module with no dependency added, the collision
 * rate is fine for fixture identity (32 bits over a hand-authored fixture set
 * of ~100 entries), and the output is short enough that a journal reader can
 * compare hashes by eye when a diff report renders inline. The name `fnv1a`
 * is kept for API compatibility with existing consumers — the exported
 * function is a black-box "8-hex-char deterministic hash".
 *
 * `setHashMode("none")` returns "0" for every input so fixture authors can
 * write the expected journal without computing hashes; production and
 * replay-verification paths leave it at the default "fnv1a".
 *
 * @module
 */

import { createHash } from "node:crypto";

export type HashMode = "fnv1a" | "none";

let currentMode: HashMode = "fnv1a";

export function setHashMode(mode: HashMode): void {
	currentMode = mode;
}

export function getHashMode(): HashMode {
	return currentMode;
}

// SHA-256 truncated to 8 hex chars. Deterministic and dependency-free.
export function fnv1a(input: string): string {
	if (currentMode === "none") {
		return "0";
	}
	return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

// Convenience: hash a JSON-serializable value by stringifying with sorted
// keys. Used for the schema field so `{ type, properties }` and
// `{ properties, type }` produce the same hash.
export function fnv1aJson(value: unknown): string {
	return fnv1a(stableStringify(value));
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).toSorted();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
