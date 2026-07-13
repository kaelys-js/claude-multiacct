// CLI-entry coverage for `time-tracker.ts`. Mirrors the direct-run coverage
// pattern used across the sibling scripts: reset the module registry,
// retarget process.argv[1], mock process.exit as a no-op recorder, then
// dynamically re-import (with a unique query string so the module registry
// reset actually re-evaluates the top-level `if (isDirectRun())` block) so
// v8 attributes the top-level branches to a running test.
//
// `time-tracker.ts`'s `isDirectRun()` differs from its siblings: it compares
// `import.meta.filename === entry` directly (no `realpathSync`), with a
// `file://` URL fallback. These tests exercise both the positive match and
// the two ways it can fail (`!entry`, mismatched path) plus the outer
// `main()` success/throw arms.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@foundation/shell`'s `sh` backs `_detectClients()`; mock it so no real
// subprocess runs when a CLI-driven `push` reaches that code path.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn<() => Promise<unknown>>(),
}));

const HERE = import.meta.dirname;
const MODULE_PATH = path.resolve(HERE, "time-tracker.ts");
const REPO_ROOT = path.resolve(HERE, "..");
const TIME_DIR = path.join(REPO_ROOT, "discovery", "time");
const NODE_BIN = process.argv[0] ?? "node";
const ENV_KEYS = [
	"HARVEST_ACCOUNT_ID",
	"HARVEST_ACCESS_TOKEN",
	"HARVEST_TASK_ID",
	"HARVEST_TTT_INTERNAL_PROJECT_ID",
	"HARVEST_NOTE_TEMPLATE",
	"CLICKUP_TOKEN",
	"CLICKUP_TEAM_ID",
	"TRP_ALLOW_REMOTE_MUTATE",
] as const;

function restoreEnv(
	keys: readonly string[],
	orig: Readonly<Record<string, string | undefined>>,
): void {
	for (const k of keys) {
		const v = orig[k];
		if (v === undefined) {
			Reflect.deleteProperty(process.env, k);
		} else {
			process.env[k] = v;
		}
	}
}

function cleanupTask(task: string): void {
	try {
		for (const name of ["s", "clickup-pushed", "pushed"]) {
			rmSync(path.join(TIME_DIR, `${task}-${name}.json`), { force: true });
		}
	} catch {
		// best-effort
	}
	try {
		rmSync(path.join(REPO_ROOT, "discovery", "proof", task), {
			recursive: true,
			force: true,
		});
	} catch {
		// best-effort
	}
}

describe("time-tracker direct-run entry", () => {
	const originalArgv = process.argv;
	const originalEnv: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) {
		originalEnv[k] = process.env[k];
	}
	let scratch: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(path.join(tmpdir(), "tt-cli-"));
		exitCodes = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
		restoreEnv(ENV_KEYS, originalEnv);
	});

	// isDirectRun() -> false via the `!entry` short-circuit.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./time-tracker.ts`);
		expect(exitCodes).toEqual([]);
	});

	// isDirectRun() -> false: argv[1] resolves to some other, unrelated path.
	// Covers the `import.meta.filename === entry || import.meta.url ===
	// \`file://${entry}\`` comparison's false arm (neither form matches).
	it("skips main() when argv[1] does not match this module's path", async () => {
		process.argv = [NODE_BIN, path.join(scratch, "not-time-tracker.ts")];
		await import(`./time-tracker.ts`);
		expect(exitCodes).toEqual([]);
	});

	// Happy path: argv[1] === the module's own path (exact string match, the
	// primary `isDirectRun` comparison), main() runs "aggregate" against a
	// task with no sessions (zero totals, no I/O side effects beyond the
	// mkdir), and the top-level `.then`-equivalent `process.exit(code)` fires
	// with the command's own return code (0).
	it("runs main() and exits with its return code on success", async () => {
		const task = `CLI-TT-OK-${process.pid}-${Date.now()}`;
		process.argv = [NODE_BIN, MODULE_PATH, "aggregate", "--task", task];
		await import(`./time-tracker.ts`);
		expect(exitCodes).toEqual([0]);
		cleanupTask(task);
	});

	// A parse failure (missing required --task) is caught by main()'s own
	// try/catch around parseArgs() and turned into a plain return 2 — a
	// third, distinct main() outcome from the success (0) and uncaught-throw
	// (1) cases below.
	it("argument parse failure inside main() returns 2 without throwing (caught internally)", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "aggregate"]; // missing --task
		await import(`./time-tracker.ts`);
		expect(exitCodes).toEqual([2]);
	});

	// Failure path: main() throws an error that isn't caught inside main()
	// itself — pushHarvest's renderNote() raises `KeyError: '<name>'` for a
	// template referencing an unknown field, and that throw happens inside
	// cmdPush's synchronous call chain, outside main()'s own try/catch (which
	// only wraps parseArgs()). The top-level catch arm must emit stderr and
	// exit(1).
	it("catches an error thrown from deep inside a command and exits 1", async () => {
		const task = `CLI-TT-THROW-${process.pid}-${Date.now()}`;
		mkdirSync(TIME_DIR, { recursive: true });
		writeFileSync(
			path.join(TIME_DIR, `${task}-s.json`),
			JSON.stringify({
				task,
				stage: "s",
				epoch_start_ms: 0,
				epoch_end_ms: 60_000,
				duration_ms: 60_000,
			}),
		);
		process.env.HARVEST_ACCOUNT_ID = "A1";
		process.env.HARVEST_ACCESS_TOKEN = "TOK";
		process.env.HARVEST_TASK_ID = "42";
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "1000";
		process.env.HARVEST_NOTE_TEMPLATE = "{totally_unknown_field}";
		process.argv = [NODE_BIN, MODULE_PATH, "push", "--task", task, "--dry-run"];
		await import(`./time-tracker.ts`);
		expect(exitCodes).toEqual([1]);
		cleanupTask(task);
	});
});
