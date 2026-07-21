/**
 * `@foundation/shell` — execa-based command runner.
 *
 * `sh()` runs one command with the discipline the strach-poc and TRP scripts
 * used to reach for by hand: pipefail-equivalent semantics (no partial-shell
 * fallbacks, no swallowed exits), an enforced timeout, stdin closed by default
 * so a child never blocks waiting for input, and a structured error that
 * carries captured stdout/stderr so callers can journal or classify.
 *
 * @module
 */

import { execa, ExecaError } from "execa";
import { fromExecaError, ShError } from "./error.ts";
import { type Journal, nullJournal } from "./journal.ts";

// Node stream `.write(chunk, cb)` requires the callback argument to be present;
// the journal drains chunks eagerly and has nothing to do on flush, so this
// no-op satisfies the contract without allocating a fresh closure per chunk.
const noop = (): void => {
	/* no-op: node stream contract requires callback presence */
};

export type ShOptions = {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	// Hard timeout, ms. On expiry the child is SIGTERM'd, then SIGKILL'd
	// after killAfterMs. Default: 60_000. Pass 0 to disable.
	readonly timeout?: number;
	readonly killSignal?: NodeJS.Signals;
	readonly killAfterMs?: number;
	readonly journal?: Journal;
	// Reject on non-zero exit (true, default) or resolve with the failure
	// result (false — matches spawnSync semantics for callers that inspect
	// exitCode directly).
	readonly rejectOnError?: boolean;
};

export type ShResult = {
	readonly command: string;
	readonly args: readonly string[];
	readonly exitCode: number;
	readonly signal: string | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_AFTER_MS = 5000;

// Run a command with pipefail-equivalent semantics. Rejects with `ShError` on
// non-zero exit unless `rejectOnError: false` is set. Stdin is closed
// unconditionally; the wrapper's contract is non-interactive.
export async function sh(
	command: string,
	args: readonly string[] = [],
	options: ShOptions = {},
): Promise<ShResult> {
	const journal = options.journal ?? nullJournal();
	const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
	const rejectOnError = options.rejectOnError ?? true;
	const started = Date.now();

	try {
		const subprocess = execa(command, [...args], {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			// Closed stdin: child sees EOF immediately. Prevents `read -p`
			// prompts from hanging a script and prevents inherited terminal
			// state from leaking into child behaviour.
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			/* v8 ignore next -- callers pass positive timeouts (default 60_000 ms); the `timeout: 0` disable-path is documented but not exercised by the test suite because a truly unbounded child would hang the runner */
			timeout: timeoutMs > 0 ? timeoutMs : undefined,
			killSignal: options.killSignal ?? "SIGTERM",
			forceKillAfterDelay: options.killAfterMs ?? DEFAULT_KILL_AFTER_MS,
			// We handle non-zero exits manually so the caller keeps a single
			// entry point: check `rejectOnError`, then throw a normalised
			// `ShError` with the captured streams intact.
			reject: false,
			encoding: "utf8",
		});

		subprocess.stdout?.on("data", (chunk: Buffer): void => {
			journal.out.write(chunk, noop);
		});
		subprocess.stderr?.on("data", (chunk: Buffer): void => {
			journal.err.write(chunk, noop);
		});

		const result = await subprocess;
		const durationMs = Date.now() - started;

		/* v8 ignore start -- execa with encoding: "utf8" and stdout/stderr piped resolves with string stdout/stderr; the `typeof === "string" ? ... : ""` and exitCode-number fallbacks are defensive TypeScript-narrowing against execa's wider typing and unreachable at runtime */
		const shResult: ShResult = {
			command,
			args,
			exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
			signal: result.signal ?? undefined,
			stdout: typeof result.stdout === "string" ? result.stdout : "",
			stderr: typeof result.stderr === "string" ? result.stderr : "",
			timedOut: Boolean(result.timedOut),
			durationMs,
		};
		/* v8 ignore stop */

		const failed = shResult.timedOut || shResult.exitCode !== 0 || shResult.signal !== undefined;

		if (failed && rejectOnError) {
			throw new ShError({
				command,
				args,
				exitCode: shResult.exitCode,
				signal: shResult.signal,
				stdout: shResult.stdout,
				stderr: shResult.stderr,
				timedOut: shResult.timedOut,
				durationMs,
			});
		}

		return shResult;
	} catch (error) {
		// Our own manual reject path already threw a well-formed ShError;
		// don't re-wrap it.
		if (error instanceof ShError) {
			throw error;
		}
		// Defensive: even with `reject: false`, execa surfaces spawn failures
		// (ENOENT, EACCES) as ExecaError. Normalise to ShError so callers
		// don't couple to execa's shape.
		if (error instanceof ExecaError) {
			throw fromExecaError(command, args, error, Date.now() - started);
		}
		/* v8 ignore start -- execa's own rejection is always ExecaError (execa 9.6+); the ShError arm above catches our manual reject; the else branch of the ExecaError check is unreachable without a synchronous programming error inside the try block, which the tests do not simulate */
		throw error;
		/* v8 ignore stop */
	}
}
