// Unit tests for @foundation/mutations::withMutation().
//
// WHY it matters: withMutation() is the single choke point that keeps every
// remote-write path safe by default. Every failure mode here corresponds to
// a real safety guarantee, not just a behaviour observation:
//   - dry-run when either flag is off  → prevents accidental writes from a
//     partially-configured shell.
//   - execute called EXACTLY once when both flags on → contract with callers
//     that a mutation is not duplicated by the gate itself.
//   - case-insensitive on "true" AND no whitespace trim → locks the arming
//     rule so nobody weakens it later (e.g. accepting "1"/"yes") and creates
//     a wider footgun.
//   - unknown service rejected at parse → schema is the safety net; a typo
//     that skipped this would look up an undefined key on the env object.
//   - default logger writes to process.stderr (never console.log) → the
//     project rule; a regression here would flood stdout in CI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	parseMutationsEnv,
	withMutation,
	type Logger,
	type MutationOutcome,
	type MutationPlan,
} from "../src/index.ts";

// Build a Logger spy pair for assertion. Kept per-test so calls don't leak.
function makeLoggerSpy(): {
	logger: Logger;
	info: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
} {
	const info = vi.fn<(msg: string, data?: unknown) => void>();
	const warn = vi.fn<(msg: string, data?: unknown) => void>();
	return { logger: { info, warn }, info, warn };
}

// Narrowing helpers — moved out of test bodies so the `if`-based type guard
// doesn't count as a conditional inside the `it()` block
// (vitest/no-conditional-in-test). Both throw loudly so a wrong-branch
// outcome fails the test at the assertion site, matching the original
// `if (outcome.mutated) throw` shape.
function assertDryRun<T>(
	outcome: MutationOutcome<T>,
): asserts outcome is Extract<MutationOutcome<T>, { mutated: false }> {
	if (outcome.mutated) {
		throw new Error("expected dry-run outcome, got applied");
	}
}

function assertApplied<T>(
	outcome: MutationOutcome<T>,
): asserts outcome is Extract<MutationOutcome<T>, { mutated: true }> {
	if (!outcome.mutated) {
		throw new Error("expected applied outcome, got dry-run");
	}
}

// Env with every flag off — the default that all consumers boot into unless
// something in the shell explicitly arms it.
const OFF_ENV = parseMutationsEnv({});

describe("withMutation — dry-run paths", () => {
	it("leaves execute() untouched and logs the [DRY-RUN] shape when MUTATIONS_ENABLED is off but per-service flag is on", async () => {
		// WHY: the global kill-switch must dominate the per-service flag. If a
		// developer only exports GITHUB_WRITES_ENABLED they get dry-run.
		const env = parseMutationsEnv({ GITHUB_WRITES_ENABLED: "true" });
		const execute = vi.fn<() => Promise<unknown>>();
		const { logger, info } = makeLoggerSpy();

		const plan: MutationPlan = {
			service: "github",
			action: "post PR comment",
			args: { number: 42 },
		};
		const outcome = await withMutation(plan, execute, { env, logger });

		expect(execute).not.toHaveBeenCalled();
		expect(outcome.mutated).toBe(false);
		assertDryRun(outcome);
		expect(outcome.reason).toBe("dry-run");
		expect(outcome.result).toBeNull();
		expect(outcome.gate).toEqual({ globalEnabled: false, serviceEnabled: true });
		// Exact-string lock on the log shape the task specifies.
		expect(info).toHaveBeenCalledOnce();
		expect(info.mock.calls[0]?.[0]).toBe(
			'[DRY-RUN] would call post PR comment with args {"number":42}',
		);
	});

	it("stays in dry-run when MUTATIONS_ENABLED is on but the per-service flag is off", async () => {
		// WHY: symmetry with the case above. Both flags are required.
		const env = parseMutationsEnv({ MUTATIONS_ENABLED: "true" });
		const execute = vi.fn<() => Promise<unknown>>();
		const { logger, info } = makeLoggerSpy();

		const outcome = await withMutation(
			{ service: "clickup", action: "create task", args: { list: "abc" } },
			execute,
			{ env, logger },
		);

		expect(execute).not.toHaveBeenCalled();
		expect(outcome.mutated).toBe(false);
		assertDryRun(outcome);
		expect(outcome.gate).toEqual({ globalEnabled: true, serviceEnabled: false });
		expect(info.mock.calls[0]?.[0]).toBe(
			'[DRY-RUN] would call create task with args {"list":"abc"}',
		);
	});

	it("stays in dry-run when NEITHER flag is set (default posture)", async () => {
		// WHY: default posture is the safe one. This test protects against a
		// future refactor that inverts the default.
		const execute = vi.fn<() => Promise<unknown>>();
		const { logger, info } = makeLoggerSpy();

		const outcome = await withMutation(
			{ service: "memex", action: "publish entries", args: { count: 3 } },
			execute,
			{ env: OFF_ENV, logger },
		);

		expect(execute).not.toHaveBeenCalled();
		expect(outcome.mutated).toBe(false);
		expect(info).toHaveBeenCalledOnce();
	});

	it.each([
		["true ", "trailing whitespace stays dry-run — no trim"],
		["false", "explicit false stays dry-run"],
		["1", 'the string "1" is not "true"'],
		["yes", 'the string "yes" is not "true"'],
		["on", 'the string "on" is not "true"'],
		["", "empty string stays dry-run"],
	])("MUTATIONS_ENABLED=%p stays dry-run (%s)", async (raw, _why) => {
		// WHY: locks the arming rule. If someone loosens the check to a truthy
		// coercion or trims whitespace, one of these fails.
		const env = parseMutationsEnv({
			MUTATIONS_ENABLED: raw,
			GIT_PUSH_ENABLED: "true",
		});
		const execute = vi.fn<() => Promise<unknown>>();
		const { logger } = makeLoggerSpy();

		const outcome = await withMutation(
			{ service: "git-push", action: "push branch", args: { remote: "origin" } },
			execute,
			{ env, logger },
		);
		expect(execute).not.toHaveBeenCalled();
		expect(outcome.mutated).toBe(false);
	});
});

describe("withMutation — armed path", () => {
	it("calls execute() exactly once and returns the result when both flags are 'true'", async () => {
		// WHY: contract with callers. The gate never duplicates or drops the
		// mutation once armed; execute is invoked exactly once and its return
		// value flows straight through.
		const env = parseMutationsEnv({
			MUTATIONS_ENABLED: "true",
			GITHUB_WRITES_ENABLED: "true",
		});
		// `() => Promise.resolve(...)` instead of an `async` arrow so
		// eslint/require-await doesn't fire on the sync body.
		const execute = vi.fn<() => Promise<{ id: number }>>(() => Promise.resolve({ id: 7 }));
		const { logger, info } = makeLoggerSpy();

		const outcome = await withMutation(
			{ service: "github", action: "create PR", args: { title: "chore: seed" } },
			execute,
			{ env, logger },
		);

		expect(execute).toHaveBeenCalledOnce();
		expect(outcome.mutated).toBe(true);
		assertApplied(outcome);
		expect(outcome.result).toEqual({ id: 7 });
		expect(info).toHaveBeenCalledWith("[APPLIED] create PR", { service: "github" });
	});

	it.each([
		["TRUE", "TRUE"],
		["True", "True"],
		["tRuE", "tRuE"],
	])("arms on case-insensitive 'true' (env=%p, service=%p)", async (globalRaw, serviceRaw) => {
		// WHY: locks the case-insensitive rule. Removing `.toLowerCase()` would
		// break this without touching any other test.
		const env = parseMutationsEnv({
			MUTATIONS_ENABLED: globalRaw,
			CALENDAR_INVITE_ENABLED: serviceRaw,
		});
		const execute = vi.fn<() => Promise<string>>(() => Promise.resolve("sent"));

		const outcome = await withMutation(
			{ service: "calendar", action: "send invite", args: { to: "cole@ttt.studio" } },
			execute,
			{ env },
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(outcome.mutated).toBe(true);
	});

	it("propagates errors from execute() unchanged (does NOT log [APPLIED] on failure)", async () => {
		// WHY: the gate must not swallow errors — the caller decides what to do
		// with a failed remote call. A defensive try/catch here would hide bugs.
		const env = parseMutationsEnv({
			MUTATIONS_ENABLED: "true",
			CLICKUP_WRITES_ENABLED: "true",
		});
		// `Promise.reject` keeps the sync body throw-free so eslint/require-await
		// stays quiet while still surfacing the failure via the returned promise.
		const execute = vi.fn<() => Promise<never>>(() => Promise.reject(new Error("clickup 500")));
		const { logger, info } = makeLoggerSpy();

		await expect(
			withMutation({ service: "clickup", action: "post comment", args: { task: "x" } }, execute, {
				env,
				logger,
			}),
		).rejects.toThrow("clickup 500");
		// The [APPLIED] log line runs AFTER execute() resolves; on a throw it
		// must not fire, otherwise the log misrepresents outcome.
		expect(info).not.toHaveBeenCalled();
	});
});

describe("withMutation — filesystem service", () => {
	it("stays in dry-run when FILESYSTEM_WRITES_ENABLED is off", async () => {
		// WHY: the filesystem gate is what the dashboard refresh uses to decide
		// whether to write docs/dashboard.md. Default posture (env unset) must
		// leave the file untouched — the log line is the only side effect.
		const env = parseMutationsEnv({ MUTATIONS_ENABLED: "true" });
		const execute = vi.fn<() => Promise<unknown>>();
		const { logger, info } = makeLoggerSpy();

		const outcome = await withMutation(
			{ service: "filesystem", action: "write dashboard", args: { path: "docs/dashboard.md" } },
			execute,
			{ env, logger },
		);
		expect(execute).not.toHaveBeenCalled();
		expect(outcome.mutated).toBe(false);
		expect(info.mock.calls[0]?.[0]).toBe(
			'[DRY-RUN] would call write dashboard with args {"path":"docs/dashboard.md"}',
		);
	});

	it("arms when both MUTATIONS_ENABLED and FILESYSTEM_WRITES_ENABLED are 'true'", async () => {
		// WHY: locks the pairing rule for the new service so nobody drifts it
		// (e.g. by wiring the dashboard write to GIT_PUSH_ENABLED, which would
		// couple local file refresh to remote-push arming).
		const env = parseMutationsEnv({
			MUTATIONS_ENABLED: "true",
			FILESYSTEM_WRITES_ENABLED: "true",
		});
		const execute = vi.fn<() => Promise<string>>(() => Promise.resolve("written"));
		const outcome = await withMutation(
			{ service: "filesystem", action: "write dashboard", args: { path: "x" } },
			execute,
			{ env },
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(outcome.mutated).toBe(true);
		assertApplied(outcome);
		expect(outcome.result).toBe("written");
	});
});

describe("withMutation — plan validation", () => {
	it("rejects an unknown service at parse time (schema safety net)", async () => {
		// WHY: a typo like { service: "githbu" } would otherwise look up an
		// undefined flag on the env object. The schema catches it. The valibot
		// picklist message begins with "Invalid" — locking that substring
		// keeps future schema-lib swaps from silently swallowing the reject.
		const execute = vi.fn<() => Promise<unknown>>();
		await expect(
			withMutation(
				// Deliberate bad shape — exercises the schema safety net.
				{ service: "githbu" as unknown as MutationPlan["service"], action: "typo", args: {} },
				execute,
				{ env: OFF_ENV },
			),
		).rejects.toThrow("Invalid");
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a plan with a non-string action", async () => {
		// WHY: log line interpolates action into a string; a non-string would
		// coerce to "[object Object]" and produce a useless log entry. Same
		// "Invalid" substring anchor as above — valibot's picklist and string
		// checks both prefix their issue messages with that word.
		const execute = vi.fn<() => Promise<unknown>>();
		await expect(
			withMutation({ service: "github", action: 42 as unknown as string, args: {} }, execute, {
				env: OFF_ENV,
			}),
		).rejects.toThrow("Invalid");
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("withMutation — default logger", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// WHY spy on process.stderr specifically: the project rule bans
		// console.log; the default logger must write to stderr. A regression
		// that swaps to console.* would leave process.stderr.write untouched.
		stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("falls back to process.stderr when no logger is provided (never console.log)", async () => {
		const outcome = await withMutation(
			{ service: "github", action: "noop", args: { a: 1 } },
			vi.fn<() => Promise<unknown>>(),
			{ env: OFF_ENV },
		);
		expect(outcome.mutated).toBe(false);
		expect(stderrSpy).toHaveBeenCalled();
		// Destructure the first recorded call and its first argument; the
		// test config permits non-null assertions so we skip a defensive
		// fallback that would drag `??` back into the test body (banned by
		// vitest/no-conditional-in-test).
		const [firstCall] = stderrSpy.mock.calls;
		const firstArg = String(firstCall![0]);
		expect(firstArg).toContain("[DRY-RUN] would call noop with args ");
		// Data suffix is serialised JSON on the same line.
		expect(firstArg).toMatch(/\{"service":"github"/u);
		expect(firstArg.endsWith("\n")).toBe(true);
	});
});
