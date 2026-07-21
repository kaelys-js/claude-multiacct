import { expect } from "vitest";

/**
 * `@foundation/claude-multiacct` — shared test assertion helpers.
 *
 * A `.ts` file (not `.test.ts`) so it isn't executed as a suite but IS
 * covered by tests that import from it. The helpers exist because our
 * result unions carry an `ok` discriminator + additional narrow-to fields;
 * writing `if (r.ok) { expect(...) }` runs afoul of the vitest lint's
 * no-conditional-expect rule, and the alternative `toMatchObject` scales
 * badly across many-field asserts. A typed-asserts helper keeps the
 * expects unconditional at the call site and gives the compiler a proper
 * narrowing frame.
 *
 * @module
 */

/**
 * Assert a discriminated result is on its `ok:true` branch. Throws with a
 * printable dump when it isn't, so a failure gives the same diagnostic
 * quality as `expect(r).toMatchObject({ok: true})` would.
 *
 * @param {T} value - The result to narrow.
 * @returns {void} Narrows the type via `asserts`; no return value.
 */
export function assertOk<T extends { ok: boolean }>(value: T): asserts value is T & { ok: true } {
	// Uses vitest's `expect` so that vitest's `expect-expect` lint counts this
	// helper as a real assertion in every test that calls it.
	expect(value).toMatchObject({ ok: true });
}

/**
 * Assert a discriminated result is on its `ok:false` branch. Same narrowing
 * shape as `assertOk` for the failure side of the union.
 *
 * @param {T} value - The result to narrow.
 * @returns {void} Narrows the type via `asserts`; no return value.
 */
export function assertNotOk<T extends { ok: boolean }>(
	value: T,
): asserts value is T & { ok: false } {
	expect(value).toMatchObject({ ok: false });
}
