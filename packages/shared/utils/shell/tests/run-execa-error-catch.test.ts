// Behavior test for `@foundation/shell`'s ExecaError-catch normalisation path.
//
// WHY it matters: run.ts's catch block (lines 132-135) is defensive — even
// with `reject: false`, execa MIGHT still throw an ExecaError for some spawn
// failures. In execa 9.6.0 the observed behaviour is to resolve with a result
// carrying `failed: true` instead, but a version bump could change that.
// If the catch ever drops the ExecaError branch, callers upstream would see
// bare execa types leak past the sh() boundary — breaking the "sh() speaks
// only ShError" contract that the ROADMAP nailed down. This test forces the
// branch to fire by module-mocking execa to throw its own ExecaError, then
// asserts the result is a ShError with the original ExecaError as its cause.
//
// Kept in a separate file so the vi.mock hoist doesn't poison the real-execa
// suite in run.test.ts — every other test in that file needs the actual
// execa implementation.

import type * as ExecaModule from "execa";
import { describe, expect, it, vi } from "vitest";
import { isShError, type ShError } from "../src/error.ts";
import { sh } from "../src/run.ts";

// Sentinel fake instance we can identify from inside the test after the
// mocked execa throws it. `vi.hoisted` executes above the imports (and above
// vi.mock's factory), so the sentinel is available when the factory runs.
// We only need object identity — the actual instanceof check is patched via
// the mock's ExecaError export below.
const holder = vi.hoisted(() => ({ fake: {} as Error }));

vi.mock("execa", async (importOriginal: () => Promise<typeof ExecaModule>) => {
	const original = await importOriginal();
	// Build a real ExecaError-shaped object so `error instanceof ExecaError`
	// in run.ts (where ExecaError also comes from this mocked module) matches.
	holder.fake = Object.create(original.ExecaError.prototype, {
		message: { value: "spawn ENOENT (mocked)", enumerable: false, writable: true },
		exitCode: { value: 42, enumerable: true },
		signal: { value: undefined, enumerable: true },
		stdout: { value: "captured-out", enumerable: true },
		stderr: { value: "captured-err", enumerable: true },
		timedOut: { value: false, enumerable: true },
		name: { value: "ExecaError", enumerable: false },
	}) as Error;
	const execaMock = (): Promise<never> => {
		const p = Promise.reject(holder.fake) as Promise<never>;
		// Consume the reject so Node doesn't warn before sh()'s await sees it.
		// A floating `.catch` here is intentional — sh() awaits `p` and sees
		// the same rejection; we just need Node's unhandled-rejection watcher
		// to not fire before that await runs. try/await would swallow the
		// rejection sh() needs to catch.
		// oxlint-disable-next-line promise/prefer-await-to-then -- see above
		p.catch(() => {
			/* consumed by sh() */
		});
		return p;
	};
	return { execa: execaMock, ExecaError: original.ExecaError };
});

describe("sh — ExecaError catch normalisation", () => {
	it("wraps an execa-thrown ExecaError in a ShError via fromExecaError", async () => {
		let caught: unknown;
		try {
			await sh("mocked-cmd", ["arg1", "arg2"]);
		} catch (error) {
			caught = error;
		}
		// The catch must have normalised through fromExecaError, so:
		//   1. isShError(caught) is true (contract with callers)
		//   2. The command/args match the sh() invocation
		//   3. The captured stderr/stdout are carried through
		//   4. The original ExecaError is preserved as .cause for debugging
		expect(isShError(caught)).toBe(true);
		const err = caught as ShError;
		expect(err.command).toBe("mocked-cmd");
		expect(err.args).toEqual(["arg1", "arg2"]);
		expect(err.stdout).toBe("captured-out");
		expect(err.stderr).toBe("captured-err");
		expect((err as { cause?: unknown }).cause).toBe(holder.fake);
	});

	it("normalises even when rejectOnError is false — spawn errors bypass the flag", async () => {
		// rejectOnError only gates the manual `throw new ShError` for non-zero
		// exits. A raw ExecaError (as would arise from an execa version that
		// throws on spawn failure) always throws — otherwise sh() has no way
		// to return a well-typed ShResult for a subprocess that never lived.
		let caught: unknown;
		try {
			await sh("mocked-cmd", [], { rejectOnError: false });
		} catch (error) {
			caught = error;
		}
		expect(isShError(caught)).toBe(true);
	});
});
