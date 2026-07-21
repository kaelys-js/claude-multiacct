// Behavior tests for `@foundation/shell`'s ShError boundary.
//
// WHY it matters: callers classify failures by field (timedOut for retry,
// exitCode for structured logs, signal for kill-tree diagnostics). If any of
// these fields silently drops from the constructor or the execa adapter,
// classifiers downstream (fix-task's REVISE loop, the failure-JSON emitter)
// silently misbehave. These tests fix each field's guarantee.

import type { ExecaError } from "execa";
import { describe, expect, it } from "vitest";
import { ShError, fromExecaError, isShError } from "../src/error.ts";

describe("ShError", () => {
	it("populates every field the fix-task failure-JSON emitter reads", () => {
		const err = new ShError({
			command: "pnpm",
			args: ["run", "test"],
			exitCode: 1,
			signal: undefined,
			stdout: "one\ntwo\n",
			stderr: "boom\n",
			timedOut: false,
			durationMs: 42,
		});
		expect(err.name).toBe("ShError");
		expect(err.command).toBe("pnpm");
		expect(err.args).toEqual(["run", "test"]);
		expect(err.exitCode).toBe(1);
		expect(err.stdout).toBe("one\ntwo\n");
		expect(err.stderr).toBe("boom\n");
		expect(err.timedOut).toBe(false);
		expect(err.durationMs).toBe(42);
		expect(err.message).toContain("pnpm run test");
		expect(err.message).toContain("exit 1");
	});

	it("names the timeout in the message so log grep hits it", () => {
		const err = new ShError({
			command: "sleep",
			args: ["30"],
			exitCode: undefined,
			signal: "SIGTERM",
			stdout: "",
			stderr: "",
			timedOut: true,
			durationMs: 5000,
		});
		expect(err.message).toMatch(/timed out after 5000ms/u);
		expect(err.timedOut).toBe(true);
	});

	it("names the kill signal when a signal killed the child but no timeout fired", () => {
		const err = new ShError({
			command: "node",
			args: ["child.js"],
			exitCode: undefined,
			signal: "SIGKILL",
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 100,
		});
		expect(err.message).toMatch(/killed by SIGKILL/u);
	});

	it("attaches the cause so `err.cause` walks back to the execa failure", () => {
		const original = new Error("execa said no");
		const err = new ShError({
			command: "a",
			args: [],
			exitCode: 1,
			signal: undefined,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 1,
			cause: original,
		});
		expect((err as { cause?: unknown }).cause).toBe(original);
	});
});

describe("isShError", () => {
	it("is true for a ShError instance", () => {
		const e = new ShError({
			command: "a",
			args: [],
			exitCode: 1,
			signal: undefined,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 1,
		});
		expect(isShError(e)).toBe(true);
	});

	it("is false for a plain Error, undefined, or unrelated object", () => {
		expect(isShError(new Error("nope"))).toBe(false);
		expect(isShError(undefined)).toBe(false);
		expect(isShError({ name: "ShError" })).toBe(false);
	});
});

describe("fromExecaError", () => {
	it("normalises execa's shape into a ShError with the same fields", () => {
		const fake = {
			exitCode: 2,
			signal: undefined,
			stdout: "out\n",
			stderr: "err\n",
			timedOut: false,
		} as unknown as ExecaError;
		const err = fromExecaError("pnpm", ["run", "lint"], fake, 123);
		expect(err).toBeInstanceOf(ShError);
		expect(err.command).toBe("pnpm");
		expect(err.args).toEqual(["run", "lint"]);
		expect(err.exitCode).toBe(2);
		expect(err.signal).toBeUndefined();
		expect(err.stdout).toBe("out\n");
		expect(err.stderr).toBe("err\n");
		expect(err.timedOut).toBe(false);
		expect(err.durationMs).toBe(123);
		expect((err as { cause?: unknown }).cause).toBe(fake);
	});

	it("coerces non-string stdout/stderr to empty strings so downstream slicing is safe", () => {
		const fake = {
			exitCode: 1,
			signal: undefined,
			stdout: undefined,
			stderr: undefined,
			timedOut: false,
		} as unknown as ExecaError;
		const err = fromExecaError("a", [], fake, 1);
		expect(err.stdout).toBe("");
		expect(err.stderr).toBe("");
	});

	it("preserves the timedOut flag and signal when execa reports a timeout", () => {
		const fake = {
			exitCode: undefined,
			signal: "SIGTERM",
			stdout: "",
			stderr: "",
			timedOut: true,
		} as unknown as ExecaError;
		const err = fromExecaError("sleep", ["30"], fake, 5000);
		expect(err.timedOut).toBe(true);
		expect(err.signal).toBe("SIGTERM");
		expect(err.message).toMatch(/timed out after 5000ms/u);
	});
});
