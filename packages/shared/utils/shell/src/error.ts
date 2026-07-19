/**
 * `@foundation/shell` — structured error boundary.
 *
 * `ShError` wraps every non-zero exit from `sh()` with the fields callers
 * routinely need: the command, args, exit code, signal, stdout, stderr, and
 * whether the failure was a timeout. execa raises `ExecaError`; we normalise
 * to a single class so callers don't couple to execa's shape and so the
 * error stays serialisable for structured logs and failure JSON emission.
 *
 * @module
 */

import type { ExecaError } from "execa";

export type ShErrorInit = {
	readonly command: string;
	readonly args: readonly string[];
	readonly exitCode: number | undefined;
	readonly signal: string | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly cause?: unknown;
};

// Compose the trailing clause of the ShError message. Extracted out of the
// constructor so the branch stays flat (no nested ternary) and callers reading
// the message string know the order of preference: timeout > signal > exit.
function buildErrorSuffix(init: ShErrorInit): string {
	if (init.timedOut) {
		return `timed out after ${init.durationMs}ms`;
	}
	if (init.signal) {
		return `killed by ${init.signal}`;
	}
	return `exit ${init.exitCode ?? "?"}`;
}

export class ShError extends Error {
	readonly command: string;
	readonly args: readonly string[];
	readonly exitCode: number | undefined;
	readonly signal: string | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly durationMs: number;

	constructor(init: ShErrorInit) {
		const argv = [init.command, ...init.args].join(" ");
		const suffix = buildErrorSuffix(init);
		super(`sh: \`${argv}\` ${suffix}`);
		this.name = "ShError";
		this.command = init.command;
		this.args = init.args;
		this.exitCode = init.exitCode;
		this.signal = init.signal;
		this.stdout = init.stdout;
		this.stderr = init.stderr;
		this.timedOut = init.timedOut;
		this.durationMs = init.durationMs;
		if (init.cause !== undefined) {
			(this as { cause?: unknown }).cause = init.cause;
		}
	}
}

// Type guard. Works cross-realm and narrows `unknown` in catch clauses without
// a manual cast.
export function isShError(err: unknown): err is ShError {
	return err instanceof ShError;
}

// Adapter: turn execa's failure shape into a ShError. Called from run.ts on
// every non-zero result; exported here so tests can exercise it directly
// against a fabricated execa failure object.
export function fromExecaError(
	command: string,
	args: readonly string[],
	err: ExecaError,
	durationMs: number,
): ShError {
	return new ShError({
		command,
		args,
		exitCode: typeof err.exitCode === "number" ? err.exitCode : undefined,
		signal: err.signal ?? undefined,
		stdout: typeof err.stdout === "string" ? err.stdout : "",
		stderr: typeof err.stderr === "string" ? err.stderr : "",
		timedOut: Boolean(err.timedOut),
		durationMs,
		cause: err,
	});
}
