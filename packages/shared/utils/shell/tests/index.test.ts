// Behavior test for the `@foundation/shell` barrel.
//
// WHY it matters: the barrel is the contract every consumer imports from. If
// a symbol silently disappears (rename, refactor), downstream builds break.
// One test per public symbol keeps the barrel honest.

import { describe, expect, it } from "vitest";
import { ShError, fromExecaError, isShError, nullJournal, sh, stdioJournal } from "../src/index.ts";

describe("@foundation/shell barrel", () => {
	it("exports sh() as a callable function", () => {
		expect(typeof sh).toBe("function");
	});

	it("exports ShError as a constructible class", () => {
		const e = new ShError({
			command: "a",
			args: [],
			exitCode: 1,
			signal: undefined,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 0,
		});
		expect(isShError(e)).toBe(true);
	});

	it("exports fromExecaError as a callable adapter", () => {
		expect(typeof fromExecaError).toBe("function");
	});

	it("exports nullJournal and stdioJournal as journal factories", () => {
		const n = nullJournal();
		const s = stdioJournal();
		expect(n.out).toBeDefined();
		expect(n.err).toBeDefined();
		expect(s.out).toBeDefined();
		expect(s.err).toBeDefined();
	});
});
