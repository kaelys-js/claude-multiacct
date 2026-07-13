/**
 * `pyshim.ts` — small helpers to match Python's semantics in TS ports.
 *
 * These exist because a handful of Python operators / built-ins have subtle
 * behaviour that doesn't line up with their obvious JS equivalents:
 *
 *   - Python `round()` uses banker's rounding (round-half-to-even).
 *     JS `Math.round()` rounds half-away-from-zero. On x.5 boundaries the
 *     two disagree — `round(2.5) = 2` vs `Math.round(2.5) = 3` — which
 *     shows up in every rendered `Xh Ym`, `Xk` token count, and baseline
 *     range that our ledger emits.
 *
 *   - Python `or` falls through on any falsy left operand (None, False, 0,
 *     0.0, ""). JS `??` only falls through on `null`/`undefined`, so a
 *     `g("cache_read_tokens") ?? g("cache_tokens")` chain keeps a raw `0`
 *     instead of falling through to the fallback key.
 *
 * Keep this file tiny — it exists to close specific parity gaps, not to
 * host a general Python compatibility layer.
 *
 * @module
 */

/**
 * Round `n` to `digits` decimal places using banker's rounding
 * (round-half-to-even), matching Python's `round()`.
 *
 * Examples:
 *   pyRound(0.5)  === 0
 *   pyRound(1.5)  === 2
 *   pyRound(2.5)  === 2
 *   pyRound(-0.5) === 0
 *   pyRound(1.25, 1) === 1.2
 *
 * @param {number} n - Value to round.
 * @param {number} digits - Decimal places to round to.
 * @returns {number} `n` rounded to `digits` places, half-to-even.
 */
export function pyRound(n: number, digits = 0): number {
	const m = 10 ** digits;
	const v = n * m;
	const f = Math.floor(v);
	const d = v - f;
	if (d === 0.5) {
		// Half — round to even.
		return (f % 2 === 0 ? f : f + 1) / m;
	}
	return Math.round(v) / m;
}

/**
 * Return `x` if it is truthy in Python's sense, otherwise `fallback`.
 *
 * Python's `or`: falls through on `None`, `False`, `0`, `0.0`, `""`,
 * empty containers. `??` only catches `null`/`undefined`; use this when
 * porting `a or b or c` chains where the operands can legitimately be
 * `0` or `false`.
 *
 * @param {T} x - Value to test for Python truthiness.
 * @param {U} fallback - Value to return when `x` is Python-falsy.
 * @returns {T | U} `x` when Python-truthy, otherwise `fallback`.
 */
export function pyOr<T, U>(x: T, fallback: U): T | U {
	if (
		x === undefined ||
		x === null ||
		(x as unknown) === false ||
		(x as unknown) === 0 ||
		(x as unknown) === ""
	) {
		return fallback;
	}
	return x;
}
