// FNV-1a-64 hasher + recursive sanitizer for parity outputs.
//
// Every workflow that ships fixtures under
// `tests/fixtures/workflows/<name>/sanitize-manifest.json` counts on this
// module to emit exactly the marker shape the fixtures were captured with:
//
//   { sanitized: true, len: <number>, hash: `fnv1a-<16 hex>` }
//
// Rules the parity harness relies on:
//   - Strings whose length exceeds SANITIZE_THRESHOLD collapse into a marker.
//   - Absolute-path-shaped strings collapse to the literal `<sanitized-path>`
//     BEFORE the threshold check, so a path that would otherwise trip the
//     length check never leaks its own bytes into the hash.
//   - Arrays keep their order; objects keep insertion order.
//   - `stableStringify` sorts object keys so byte-for-byte diffing does not
//     depend on the source's key insertion order.
//
// Extracted from the inline workflow helpers per Patch 1 so the same hasher
// is shared by every workflow instead of drifting per file.

export const SANITIZE_THRESHOLD = 40;

export type SanitizeMarker = {
	sanitized: true;
	len: number;
	hash: string;
};

const FNV_OFFSET_BASIS = 0xcb_f2_9c_e4_84_22_23_25n;
const FNV_PRIME = 0x1_00_00_00_01_b3n;
const FNV_MASK_64 = 0xff_ff_ff_ff_ff_ff_ff_ffn;

// 64-bit FNV-1a over the UTF-16 code units of `input`.
//
// Returns 16 lowercase hex chars, zero-padded. Callers that emit the
// canonical marker prepend `fnv1a-` themselves.
export function fnv1a64(input: string): string {
	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < input.length; i += 1) {
		// FNV-1a is defined in terms of XOR and multiply; the bitwise ops here
		// are load-bearing, not a mistake for &&/||.
		// oxlint-disable-next-line no-bitwise
		hash ^= BigInt(input.codePointAt(i) ?? 0);
		// oxlint-disable-next-line no-bitwise
		hash = (hash * FNV_PRIME) & FNV_MASK_64;
	}
	return hash.toString(16).padStart(16, "0");
}

// Heuristic: does this string look like an absolute filesystem path we should
// collapse rather than leak into the fixture? Keep this conservative — the
// cost of a false negative is a real path bleeding into `_files_inspected`;
// the cost of a false positive is a short string collapsing that would have
// fit under the threshold anyway.
function looksLikeAbsolutePath(value: string): boolean {
	if (!value.startsWith("/")) {
		return false;
	}
	if (/\s/u.test(value)) {
		return false;
	}
	return value.length > 10;
}

function sanitizeString(value: string): string | SanitizeMarker {
	if (looksLikeAbsolutePath(value)) {
		return "<sanitized-path>";
	}
	if (value.length > SANITIZE_THRESHOLD) {
		return {
			sanitized: true,
			len: value.length,
			hash: `fnv1a-${fnv1a64(value)}`,
		};
	}
	return value;
}

// Recursively walk a JSON-shaped value, replacing overlong or path-shaped
// strings with the marker/placeholder. Non-string leaves pass through
// untouched; arrays preserve order; objects preserve key insertion order.
export function sanitize(value: unknown): unknown {
	if (typeof value === "string") {
		return sanitizeString(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitize(item));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>)) {
			out[key] = sanitize((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sortKeys(item));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
			out[key] = sortKeys((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

// JSON serialize with recursively sorted object keys. Arrays remain ordered.
// Two-space indent to match the fixtures' pretty-printed shape.
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value), null, 2);
}
