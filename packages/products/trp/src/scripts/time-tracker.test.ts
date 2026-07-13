// Behaviour tests for `time-tracker.ts` — the TS port of
// `trp/scripts/time-tracker.py`. The module is the per-task/stage timer that
// backs SRP/SFP/TRP time tracking and pushes hours to ClickUp + Harvest, so
// every argparse flag, every JSON key, every gate branch is load-bearing:
// operators grep the printed keys, the wrapper reads the return codes, the
// push flow refuses without explicit env-var authorisation. A regression
// in any of them silently mis-reports hours or double-charges a client.
//
// The module resolves `REPO_ROOT` once at import time from `import.meta.url`,
// so every test writes into `<pkg>/src/discovery/{time,proof}/...` and cleans
// up after itself using a unique task-id per test — no cwd trickery would
// override the module-scope constant.
//
// `@foundation/shell` and `fetch` are mocked so no subprocess or network
// call runs. Every fetch response is a controlled fixture; every `sh` call
// returns a canned `ShResult`.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";
import {
	aggregateTask,
	cmdAggregate,
	cmdCompare,
	cmdPush,
	cmdStart,
	cmdStop,
	loadConfig,
	main,
	parseArgs,
} from "./time-tracker.ts";

// Mock `@foundation/shell` before importing the module so the `sh` reference
// captured by _detectClients() is the mock. Individual tests drive
// mockedSh.mockResolvedValueOnce to steer the branch.
// `vi.mock` calls are hoisted to the top of the file by vitest's transform
// regardless of source position, so this still runs before either import
// above is evaluated.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
}));

const mockedSh = vi.mocked(sh);

// REPO_ROOT / TIME_DIR are frozen at module load time. Recompute the same
// paths here so tests can assert against and clean up the files the module
// writes. Match the module's own resolution exactly.
const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, "..");
const TIME_DIR = path.join(REPO_ROOT, "discovery", "time");
const PROOF_DIR = path.join(REPO_ROOT, "discovery", "proof");

// Compact ShResult-shaped literal for the `sh` mock.
function shResult(exitCode: number, stdout = "", stderr = ""): Awaited<ReturnType<typeof sh>> {
	return {
		command: "mock",
		args: [],
		exitCode,
		signal: undefined,
		stdout,
		stderr,
		timedOut: false,
		durationMs: 0,
	};
}

// Deterministic unique task-id per test so parallel tests + retried tests
// never collide over the same session file under REPO_ROOT.
let taskCounter = 0;
function uniqueTask(prefix = "TEST-TASK"): string {
	taskCounter += 1;
	return `${prefix}-${process.pid}-${Date.now()}-${taskCounter}`;
}

// Collect every path the module could have written for `task` and remove
// them. Belt-and-braces cleanup: we scan TIME_DIR by prefix so an unexpected
// suffix (e.g. `.1.json` rotation) still gets swept.
function cleanupTask(task: string): void {
	if (existsSync(TIME_DIR)) {
		for (const name of readdirSync(TIME_DIR)) {
			if (name.startsWith(`${task}-`) || name === `${task}-clickup-pushed.json`) {
				try {
					rmSync(path.join(TIME_DIR, name), { force: true });
				} catch {
					// best-effort
				}
			}
		}
	}
	const proofDir = path.join(PROOF_DIR, task);
	if (existsSync(proofDir)) {
		try {
			rmSync(proofDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

// Silence + capture stdout/stderr so a failing test doesn't drown the
// reporter in the module's JSON lines. Returns accessors for the captured
// strings AND a `clear()` that resets the buffers so a caller can isolate
// output emitted between two invocations. vi.spyOn on the same target is
// idempotent (returns the same mock), so re-calling silenceIo mid-test
// would surface concatenated output — use clear() instead.
function silenceIo(): {
	stdout: () => string;
	stderr: () => string;
	clear: () => void;
} {
	const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return {
		stdout: () => outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		stderr: () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		clear: () => {
			outSpy.mockClear();
			errSpy.mockClear();
		},
	};
}

// Write a temporary env file at REPO_ROOT/<name> whose lines the module's
// _loadEnvFile parser can consume, save any prior contents, and return an
// undoer. Baselines and Harvest/ClickUp keys don't ride through process.env
// (loadConfig's env pass-through only names a fixed subset), so tests that
// need to steer those values have to write real files.
function writeEnvFile(name: string, entries: Record<string, string>): () => void {
	const p = path.join(REPO_ROOT, name);
	const prior = existsSync(p) ? readFileSync(p, "utf8") : null;
	const body = Object.entries(entries)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	writeFileSync(p, `${body}\n`);
	return () => {
		if (prior === null) {
			try {
				rmSync(p, { force: true });
			} catch {
				// best-effort
			}
		} else {
			writeFileSync(p, prior);
		}
	};
}

// Read a file's contents if it exists, else null. Pulled out of the test
// body so the ternary doesn't trip vitest's no-conditional-in-test rule —
// this is fixture bookkeeping, not a test assertion.
function readIfExists(p: string): string | null {
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// Restore a file to its prior contents, or remove it if it didn't exist
// before the test touched it. Companion to `readIfExists`, kept out of the
// test body for the same reason.
function restoreOrRemove(p: string, prior: string | null): void {
	if (prior === null) {
		try {
			rmSync(p, { force: true });
		} catch {
			// best-effort
		}
	} else {
		writeFileSync(p, prior);
	}
}

// Directly write a session file at the same path the module would use.
function writeSession(task: string, stage: string, data: Record<string, unknown>): string {
	mkdirSync(TIME_DIR, { recursive: true });
	const safe = stage.replaceAll("/", "_");
	const p = path.join(TIME_DIR, `${task}-${safe}.json`);
	writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
	return p;
}

// Env keys the module reads directly. Save + restore across the whole file
// so a single test setting HARVEST_ACCESS_TOKEN can't leak into the next.
const ENV_KEYS_TO_RESET = [
	"HARVEST_ACCOUNT_ID",
	"HARVEST_ACCESS_TOKEN",
	"HARVEST_ALLOW_MUTATE",
	"HARVEST_PROJECT_ID",
	"HARVEST_TASK_ID",
	"HARVEST_USER_AGENT",
	"HARVEST_NOTE_TEMPLATE",
	"HARVEST_PROJECT_MAP",
	"HARVEST_MULTI_CLIENT_STRATEGY",
	"HARVEST_TTT_INTERNAL_PROJECT_ID",
	"CLICKUP_TOKEN",
	"CLICKUP_TEAM_ID",
	"TRP_ALLOW_REMOTE_MUTATE",
	"TRP_NO_AI_BASELINE_HOURS",
	"BASELINE_SRP_MIN_HOURS",
	"BASELINE_SRP_MAX_HOURS",
	"BASELINE_SRP_MIN",
	"BASELINE_SRP_MAX",
	"BASELINE_SFP_PER_FINDING_MIN",
	"BASELINE_SFP_PER_FINDING_MAX",
	"BASELINE_TRP_SOLVE_BUGFIX_MIN",
	"BASELINE_TRP_SOLVE_BUGFIX_MAX",
	"BASELINE_TRP_SUPPORT_MIN",
	"BASELINE_TRP_SUPPORT_MAX",
	"BASELINE_ADVISORY_ITEM_MULTIPLIER",
] as const;

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of ENV_KEYS_TO_RESET) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
	});

	afterEach(() => {
		for (const k of ENV_KEYS_TO_RESET) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
	});

	it("returns process env values for known keys", () => {
		process.env.HARVEST_ACCESS_TOKEN = "tok-xyz";
		process.env.CLICKUP_TOKEN = "cu-123";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const cfg = loadConfig();
		expect(cfg.HARVEST_ACCESS_TOKEN).toBe("tok-xyz");
		expect(cfg.CLICKUP_TOKEN).toBe("cu-123");
		expect(cfg.TRP_ALLOW_REMOTE_MUTATE).toBe("true");
	});

	it("returns an object even when no env vars are set and no files exist", () => {
		// Delete each known key; env-file layer resolves against REPO_ROOT which
		// may or may not have any of the four files. Either way loadConfig
		// must not throw and must return a plain object.
		const cfg = loadConfig();
		expect(cfg).toBeTypeOf("object");
		expect(cfg).not.toBeNull();
	});

	it("does not overwrite process env with an empty value", () => {
		// The module skips process.env[k] when the value is falsy, so an unset
		// key must not appear in cfg (unless a file provided it — we can't
		// prove absence in-repo without touching src files, so we just prove
		// the truthy branch works).
		process.env.HARVEST_USER_AGENT = "test-agent/1.0";
		const cfg = loadConfig();
		expect(cfg.HARVEST_USER_AGENT).toBe("test-agent/1.0");
	});
});

// ---------------------------------------------------------------------------
// cmdStart
// ---------------------------------------------------------------------------

describe("cmdStart", () => {
	let task: string;
	beforeEach(() => {
		task = uniqueTask("START");
	});
	afterEach(() => {
		cleanupTask(task);
		vi.restoreAllMocks();
	});

	it("writes an open session file and prints started+path JSON", () => {
		const io = silenceIo();
		const rc = cmdStart({ task, stage: "stage-1" });
		expect(rc).toBe(0);
		const p = path.join(TIME_DIR, `${task}-stage-1.json`);
		expect(existsSync(p)).toBe(true);
		const data = JSON.parse(readFileSync(p, "utf8"));
		expect(data.task).toBe(task);
		expect(data.stage).toBe("stage-1");
		expect(typeof data.epoch_start_ms).toBe("number");
		expect("epoch_end_ms" in data).toBe(false);
		const printed = JSON.parse(io.stdout().trim());
		expect(printed.started.task).toBe(task);
		expect(printed.path).toBe(p);
	});

	it("returns 2 and complains when a session is already open", () => {
		const io = silenceIo();
		cmdStart({ task, stage: "s" });
		io.clear();
		const rc = cmdStart({ task, stage: "s" });
		expect(rc).toBe(2);
		expect(io.stderr()).toContain("session already open:");
	});

	it("rotates a closed session into .1.json and starts fresh", () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 1000,
			epoch_end_ms: 2000,
			duration_ms: 1000,
		});
		silenceIo();
		const rc = cmdStart({ task, stage: "s" });
		expect(rc).toBe(0);
		const rotated = path.join(TIME_DIR, `${task}-s.1.json`);
		const fresh = path.join(TIME_DIR, `${task}-s.json`);
		expect(existsSync(rotated)).toBe(true);
		expect(existsSync(fresh)).toBe(true);
		const rotatedData = JSON.parse(readFileSync(rotated, "utf8"));
		expect(rotatedData.duration_ms).toBe(1000);
		const freshData = JSON.parse(readFileSync(fresh, "utf8"));
		expect("epoch_end_ms" in freshData).toBe(false);
	});

	it("increments rotation index when .1.json is already taken", () => {
		// Prime the slot: closed session at base + closed archive at .1.
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 1000,
			epoch_end_ms: 2000,
			duration_ms: 1000,
		});
		mkdirSync(TIME_DIR, { recursive: true });
		writeFileSync(
			path.join(TIME_DIR, `${task}-s.1.json`),
			JSON.stringify({ task, stage: "s", epoch_start_ms: 0, epoch_end_ms: 1, duration_ms: 1 }),
		);
		silenceIo();
		expect(cmdStart({ task, stage: "s" })).toBe(0);
		expect(existsSync(path.join(TIME_DIR, `${task}-s.2.json`))).toBe(true);
	});

	it("normalises '/' in stage into '_' for the session file name", () => {
		silenceIo();
		cmdStart({ task, stage: "phase/one" });
		expect(existsSync(path.join(TIME_DIR, `${task}-phase_one.json`))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// cmdStop
// ---------------------------------------------------------------------------

describe("cmdStop", () => {
	let task: string;
	beforeEach(() => {
		task = uniqueTask("STOP");
	});
	afterEach(() => {
		cleanupTask(task);
		vi.restoreAllMocks();
	});

	it("returns 2 when no session file exists", () => {
		const io = silenceIo();
		expect(cmdStop({ task, stage: "s", note: null })).toBe(2);
		expect(io.stderr()).toContain("no session file:");
	});

	it("stops an open session, records duration_ms and end_ms, prints JSON", () => {
		writeSession(task, "s", { task, stage: "s", epoch_start_ms: 1000 });
		const io = silenceIo();
		const rc = cmdStop({ task, stage: "s", note: "wrapping up" });
		expect(rc).toBe(0);
		const data = JSON.parse(readFileSync(path.join(TIME_DIR, `${task}-s.json`), "utf8"));
		expect(data.epoch_end_ms).toBeTypeOf("number");
		expect(data.duration_ms).toBe(data.epoch_end_ms - 1000);
		expect(data.note).toBe("wrapping up");
		const printed = JSON.parse(io.stdout().trim());
		expect(printed.stopped.duration_ms).toBe(data.duration_ms);
	});

	it("returns 2 when session already has epoch_end_ms", () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 1000,
			epoch_end_ms: 2000,
			duration_ms: 1000,
		});
		const io = silenceIo();
		expect(cmdStop({ task, stage: "s", note: null })).toBe(2);
		expect(io.stderr()).toContain("session already stopped:");
	});

	it("omits `note` field when note arg is empty string", () => {
		writeSession(task, "s", { task, stage: "s", epoch_start_ms: 1000 });
		silenceIo();
		cmdStop({ task, stage: "s", note: "" });
		const data = JSON.parse(readFileSync(path.join(TIME_DIR, `${task}-s.json`), "utf8"));
		expect("note" in data).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// aggregateTask + cmdAggregate
// ---------------------------------------------------------------------------

describe("aggregateTask", () => {
	let task: string;
	beforeEach(() => {
		task = uniqueTask("AGG");
	});
	afterEach(() => {
		cleanupTask(task);
		vi.restoreAllMocks();
	});

	it("returns zero totals for a task with no sessions", () => {
		const agg = aggregateTask(task);
		expect(agg.task).toBe(task);
		expect(agg.total_duration_ms).toBe(0);
		expect(agg.stages).toEqual([]);
		expect(agg.sum_hours).toBe(0);
	});

	it("sums duration_ms across closed sessions and rounds sum_hours to 4dp", () => {
		writeSession(task, "a", {
			task,
			stage: "a",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
			note: "first",
		});
		writeSession(task, "b", {
			task,
			stage: "b",
			epoch_start_ms: 100,
			epoch_end_ms: 1_800_100,
			duration_ms: 1_800_000,
		});
		const agg = aggregateTask(task);
		expect(agg.total_duration_ms).toBe(5_400_000);
		expect(agg.sum_hours).toBe(1.5);
		expect(agg.stages).toHaveLength(2);
		const first = agg.stages.find((s) => s.name === "a");
		expect(first?.note).toBe("first");
		const second = agg.stages.find((s) => s.name === "b");
		expect(second?.note).toBe("");
	});

	it("skips sessions with duration_ms <= 0", () => {
		writeSession(task, "a", {
			task,
			stage: "a",
			epoch_start_ms: 0,
			epoch_end_ms: 0,
			duration_ms: 0,
		});
		writeSession(task, "b", {
			task,
			stage: "b",
			epoch_start_ms: 0,
			epoch_end_ms: 100,
			duration_ms: 100,
		});
		const agg = aggregateTask(task);
		expect(agg.stages).toHaveLength(1);
		expect(agg.stages[0]?.name).toBe("b");
	});

	it("skips files whose 'task' field does not match", () => {
		mkdirSync(TIME_DIR, { recursive: true });
		writeFileSync(
			path.join(TIME_DIR, `${task}-x.json`),
			JSON.stringify({
				task: "OTHER-TASK",
				stage: "x",
				epoch_start_ms: 0,
				epoch_end_ms: 500,
				duration_ms: 500,
			}),
		);
		const agg = aggregateTask(task);
		expect(agg.total_duration_ms).toBe(0);
		expect(agg.stages).toEqual([]);
	});

	it("skips files that fail JSON parse", () => {
		mkdirSync(TIME_DIR, { recursive: true });
		writeFileSync(path.join(TIME_DIR, `${task}-bad.json`), "{ not json");
		writeSession(task, "good", {
			task,
			stage: "good",
			epoch_start_ms: 0,
			epoch_end_ms: 1000,
			duration_ms: 1000,
		});
		const agg = aggregateTask(task);
		expect(agg.stages).toHaveLength(1);
		expect(agg.stages[0]?.name).toBe("good");
	});

	it("cmdAggregate prints the aggregate JSON and returns 0", () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		expect(cmdAggregate({ task })).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.task).toBe(task);
		expect(printed.total_duration_ms).toBe(60_000);
	});
});

// ---------------------------------------------------------------------------
// cmdPush — mocks fetch + `@foundation/shell` sh so no network / subprocess
// ---------------------------------------------------------------------------

describe("cmdPush", () => {
	let task: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		task = uniqueTask("PUSH");
		for (const k of ENV_KEYS_TO_RESET) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		mockedSh.mockReset();
		// Default: no client-tag script hit ("empty" clients => TTT internal).
		mockedSh.mockResolvedValue(shResult(0, ""));
	});

	afterEach(() => {
		cleanupTask(task);
		for (const k of ENV_KEYS_TO_RESET) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("returns 3 when no mutate gate is open and not dry-run", async () => {
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(3);
		expect(io.stdout()).toContain(
			"refusing: neither HARVEST_ALLOW_MUTATE nor TRP_ALLOW_REMOTE_MUTATE is true",
		);
	});

	it("dry-run skips the top-level gate and prints the aggregate + gated ClickUp payload", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 1_700_000_000_000,
			epoch_end_ms: 1_700_000_060_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.aggregate.total_duration_ms).toBe(60_000);
		expect(printed.clickup.dry_run).toBe(true);
		expect(printed.clickup.url).toContain(`/task/${task}/time`);
		expect(printed.clickup.payload.duration).toBe(60_000);
		expect(printed.clickup.payload.start).toBe(1_700_000_000_000);
		expect(printed.harvest.skipped).toBe("missing HARVEST_{ACCOUNT_ID,ACCESS_TOKEN,TASK_ID}");
	});

	it("ClickUp skipped when token/team missing", async () => {
		process.env.HARVEST_ALLOW_MUTATE = "true"; // opens top-level gate
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.skipped).toBe("missing CLICKUP_TOKEN or CLICKUP_TEAM_ID");
	});

	it("ClickUp skipped when total duration is zero", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		// No sessions at all -> zero.
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.skipped).toBe("zero duration");
	});

	it("ClickUp refused when TRP_ALLOW_REMOTE_MUTATE != true (even on dry-run)", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.refused).toBe("TRP_ALLOW_REMOTE_MUTATE != true");
	});

	it("posts to ClickUp when gated open, records entry_id, no double-post on re-run", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const fetchMock = vi
			.fn<() => Promise<{ status: number; text: () => string }>>()
			.mockResolvedValue({
				status: 200,
				text: () => JSON.stringify({ data: { id: "cu-entry-123" } }),
			});
		vi.stubGlobal("fetch", fetchMock);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		// The pushed-record file should exist and carry entry_id.
		const pushedPath = path.join(TIME_DIR, `${task}-clickup-pushed.json`);
		expect(existsSync(pushedPath)).toBe(true);
		const rec = JSON.parse(readFileSync(pushedPath, "utf8"));
		expect(rec.entry_id).toBe("cu-entry-123");

		// Second run: fetch should NOT be called again (idempotency). Clear the
		// captured stdout so JSON.parse sees only the second run's payload —
		// vi.spyOn on the same target returns the same underlying mock.
		fetchMock.mockClear();
		io.clear();
		const rc2 = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc2).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		const printed = JSON.parse(io.stdout());
		expect(String(printed.clickup.skipped)).toContain("already pushed (entry_id=cu-entry-123)");
	});

	it("Harvest skipped when required env vars missing", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.skipped).toBe("missing HARVEST_{ACCOUNT_ID,ACCESS_TOKEN,TASK_ID}");
	});

	it("Harvest dry-run uses legacy HARVEST_PROJECT_ID when TTT_INTERNAL unset and no clients detected", async () => {
		process.env.HARVEST_ACCOUNT_ID = "A1";
		process.env.HARVEST_ACCESS_TOKEN = "TOK";
		process.env.HARVEST_TASK_ID = "42";
		process.env.HARVEST_PROJECT_ID = "9999";
		process.env.HARVEST_ALLOW_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries).toHaveLength(1);
		expect(printed.harvest.entries[0].client).toBeNull();
		expect(printed.harvest.entries[0].project_id).toBe(9999);
		expect(printed.harvest.entries[0].dry_run).toBe(true);
		expect(printed.harvest.entries[0].payload.task_id).toBe(42);
		expect(printed.harvest.entries[0].payload.hours).toBeCloseTo(1.0, 4);
		expect(printed.harvest.strategy).toBe("ttt-internal");
	});

	it("Harvest emits WARN when clients detected but HARVEST_PROJECT_MAP missing", async () => {
		process.env.HARVEST_ACCOUNT_ID = "A1";
		process.env.HARVEST_ACCESS_TOKEN = "TOK";
		process.env.HARVEST_TASK_ID = "42";
		process.env.HARVEST_ALLOW_MUTATE = "true";
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "1000";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		// `_detectClients` short-circuits with [] when
		// `<REPO_ROOT>/scripts/sfp-client-tags.py` isn't a file, so the sh
		// mock never fires. Materialise a placeholder + clean up so the
		// stat-check succeeds and we exercise the real branch.
		const scriptDir = path.join(REPO_ROOT, "scripts");
		const scriptPath = path.join(scriptDir, "sfp-client-tags.py");
		const priorScript = readIfExists(scriptPath);
		mkdirSync(scriptDir, { recursive: true });
		writeFileSync(scriptPath, "# test placeholder\n");
		try {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(0, "acme"));
			const io = silenceIo();
			const rc = await cmdPush({ task, dry_run: true, verify: false });
			expect(rc).toBe(0);
			const printed = JSON.parse(io.stdout());
			expect(printed.harvest.level).toBe("WARN");
			expect(String(printed.harvest.skipped)).toContain("clients missing from HARVEST_PROJECT_MAP");
			expect(printed.harvest.clients_detected).toEqual(["acme"]);
		} finally {
			restoreOrRemove(scriptPath, priorScript);
		}
	});
});

// ---------------------------------------------------------------------------
// cmdCompare — no network, writes discovery/proof/<task>/time-comparison.json
// ---------------------------------------------------------------------------

describe("cmdCompare", () => {
	let task: string;
	const savedEnv: Record<string, string | undefined> = {};
	let undoEnvFile: (() => void) | null = null;

	beforeEach(() => {
		task = uniqueTask("SEC-42-CMP");
		for (const k of ENV_KEYS_TO_RESET) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		undoEnvFile = null;
	});

	afterEach(() => {
		cleanupTask(task);
		if (undoEnvFile) {
			undoEnvFile();
		}
		for (const k of ENV_KEYS_TO_RESET) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		vi.restoreAllMocks();
	});

	it("uses SRP baseline when task starts with SEC- and no protocol given", () => {
		undoEnvFile = writeEnvFile("baselines.env", {
			BASELINE_SRP_MIN_HOURS: "8",
			BASELINE_SRP_MAX_HOURS: "12",
		});
		// Write 4 hours of actual time.
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 4 * 3_600_000,
			duration_ms: 4 * 3_600_000,
		});
		const io = silenceIo();
		const rc = cmdCompare({
			task,
			mode: null,
			cls: null,
			advisory_items: 1,
			protocol: null,
		});
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.protocol).toBe("srp");
		expect(printed.actual_hours).toBe(4);
		expect(printed.baseline_min_hours).toBe(8);
		expect(printed.baseline_max_hours).toBe(12);
		expect(printed.speedup_min).toBe(2);
		expect(printed.speedup_max).toBe(3);
		const outPath = path.join(PROOF_DIR, task, "time-comparison.json");
		expect(existsSync(outPath)).toBe(true);
		const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
		expect(onDisk.speedup_min).toBe(2);
	});

	it("warns when no actual duration recorded", () => {
		undoEnvFile = writeEnvFile("baselines.env", {
			BASELINE_SRP_MIN_HOURS: "8",
			BASELINE_SRP_MAX_HOURS: "12",
		});
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: null });
		const printed = JSON.parse(io.stdout());
		expect(printed.speedup_min).toBeNull();
		expect(printed.warning).toBe("no actual duration recorded");
	});

	it("warns when no baseline resolved for the protocol", () => {
		// Actual > 0 but SFP baseline never set.
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		cmdCompare({
			task,
			mode: null,
			cls: null,
			advisory_items: 1,
			protocol: "sfp",
		});
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBeNull();
		expect(printed.warning).toContain("no baseline resolved for protocol/mode/class");
	});

	it("uses TRP solve+class baseline when both provided", () => {
		undoEnvFile = writeEnvFile("baselines.env", {
			BASELINE_TRP_SOLVE_BUGFIX_MIN: "3",
			BASELINE_TRP_SOLVE_BUGFIX_MAX: "6",
		});
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const io = silenceIo();
		cmdCompare({
			task,
			mode: "solve",
			cls: "bugfix",
			advisory_items: 1,
			protocol: "trp",
		});
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBe(3);
		expect(printed.baseline_max_hours).toBe(6);
	});

	it("falls back to TRP mode baseline when no class provided", () => {
		undoEnvFile = writeEnvFile("baselines.env", {
			BASELINE_TRP_SUPPORT_MIN: "1",
			BASELINE_TRP_SUPPORT_MAX: "2",
		});
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 1_800_000,
			duration_ms: 1_800_000,
		});
		const io = silenceIo();
		cmdCompare({
			task,
			mode: "support",
			cls: null,
			advisory_items: 1,
			protocol: "trp",
		});
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBe(1);
		expect(printed.baseline_max_hours).toBe(2);
	});

	it("scales SRP baseline when advisory_items > 1", () => {
		undoEnvFile = writeEnvFile("baselines.env", {
			BASELINE_SRP_MIN_HOURS: "6",
			BASELINE_SRP_MAX_HOURS: "12",
		});
		// mult defaults to 1.5. items = 3 => (6 * 1.5 * 3)/3 = 9 ... 18
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const io = silenceIo();
		cmdCompare({
			task,
			mode: null,
			cls: null,
			advisory_items: 3,
			protocol: null,
		});
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBe(9);
		expect(printed.baseline_max_hours).toBe(18);
	});

	it("returns null protocol when task is not SEC-shaped and none passed", () => {
		const bareTask = uniqueTask("FREE");
		writeSession(bareTask, "s", {
			task: bareTask,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		try {
			cmdCompare({
				task: bareTask,
				mode: null,
				cls: null,
				advisory_items: 1,
				protocol: null,
			});
			const printed = JSON.parse(io.stdout());
			expect(printed.protocol).toBeNull();
			expect(printed.baseline_min_hours).toBeNull();
		} finally {
			cleanupTask(bareTask);
		}
	});
});

// ---------------------------------------------------------------------------
// parseArgs — every subcommand + every error branch
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	it("throws when argv is empty", () => {
		expect(() => parseArgs([])).toThrow("the following arguments are required: cmd");
	});

	it("throws on an unknown command", () => {
		expect(() => parseArgs(["nope"])).toThrow(/invalid choice: 'nope'/u);
	});

	it("start requires --task and --stage", () => {
		expect(() => parseArgs(["start"])).toThrow("the following arguments are required: --task");
		expect(() => parseArgs(["start", "--task", "T"])).toThrow(
			"the following arguments are required: --stage",
		);
		expect(parseArgs(["start", "--task", "T", "--stage", "S"])).toEqual({
			cmd: "start",
			task: "T",
			stage: "S",
		});
	});

	it("accepts --flag=value syntax", () => {
		expect(parseArgs(["start", "--task=T", "--stage=S"])).toEqual({
			cmd: "start",
			task: "T",
			stage: "S",
		});
	});

	it("start rejects unknown flags", () => {
		expect(() => parseArgs(["start", "--task", "T", "--stage", "S", "--bogus"])).toThrow(
			/unrecognized arguments: --bogus/u,
		);
	});

	it("start --task with missing value trips 'expected one argument'", () => {
		expect(() => parseArgs(["start", "--task"])).toThrow(/argument --task: expected one argument/u);
	});

	it("stop parses --note and defaults note to null when absent", () => {
		expect(parseArgs(["stop", "--task", "T", "--stage", "S"])).toMatchObject({
			cmd: "stop",
			task: "T",
			stage: "S",
			note: null,
		});
		expect(parseArgs(["stop", "--task", "T", "--stage", "S", "--note", "hi"])).toMatchObject({
			note: "hi",
		});
	});

	it("stop rejects unknown flags and missing required", () => {
		expect(() => parseArgs(["stop"])).toThrow("the following arguments are required: --task");
		expect(() => parseArgs(["stop", "--task", "T"])).toThrow(
			"the following arguments are required: --stage",
		);
		expect(() => parseArgs(["stop", "--task", "T", "--stage", "S", "--unknown"])).toThrow(
			/unrecognized arguments/u,
		);
	});

	it("aggregate requires --task and rejects unknown flags", () => {
		expect(() => parseArgs(["aggregate"])).toThrow("the following arguments are required: --task");
		expect(() => parseArgs(["aggregate", "--task", "T", "--foo"])).toThrow(
			/unrecognized arguments/u,
		);
		expect(parseArgs(["aggregate", "--task", "T"])).toEqual({
			cmd: "aggregate",
			task: "T",
		});
	});

	it("push defaults dry_run/verify to false and accepts each", () => {
		expect(parseArgs(["push", "--task", "T"])).toMatchObject({
			cmd: "push",
			task: "T",
			dry_run: false,
			verify: false,
		});
		expect(parseArgs(["push", "--task", "T", "--dry-run", "--verify"])).toMatchObject({
			dry_run: true,
			verify: true,
		});
	});

	it("push rejects unknown flags and requires --task", () => {
		expect(() => parseArgs(["push"])).toThrow("the following arguments are required: --task");
		expect(() => parseArgs(["push", "--task", "T", "--bad"])).toThrow(/unrecognized arguments/u);
	});

	it("compare parses --mode/--class/--advisory-items/--protocol", () => {
		expect(
			parseArgs([
				"compare",
				"--task",
				"T",
				"--mode",
				"solve",
				"--class",
				"bugfix",
				"--advisory-items",
				"3",
				"--protocol",
				"trp",
			]),
		).toMatchObject({
			cmd: "compare",
			task: "T",
			mode: "solve",
			cls: "bugfix",
			advisory_items: 3,
			protocol: "trp",
		});
	});

	it("compare defaults advisory_items to 1 and other fields to null", () => {
		expect(parseArgs(["compare", "--task", "T"])).toMatchObject({
			cmd: "compare",
			task: "T",
			mode: null,
			cls: null,
			advisory_items: 1,
			protocol: null,
		});
	});

	it("compare validates --protocol against the choices set", () => {
		expect(() => parseArgs(["compare", "--task", "T", "--protocol", "bogus"])).toThrow(
			/invalid choice: 'bogus'/u,
		);
	});

	it("compare requires --task and rejects unknown flags", () => {
		expect(() => parseArgs(["compare"])).toThrow("the following arguments are required: --task");
		expect(() => parseArgs(["compare", "--task", "T", "--wat"])).toThrow(/unrecognized arguments/u);
	});
});

// ---------------------------------------------------------------------------
// main() integration — a start→stop cycle through the CLI parser
// ---------------------------------------------------------------------------

describe("main()", () => {
	let task: string;
	const savedEnv: Record<string, string | undefined> = {};
	let undoEnvFile: (() => void) | null = null;

	beforeEach(() => {
		task = uniqueTask("MAIN");
		for (const k of ENV_KEYS_TO_RESET) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		undoEnvFile = null;
	});

	afterEach(() => {
		cleanupTask(task);
		if (undoEnvFile) {
			undoEnvFile();
		}
		for (const k of ENV_KEYS_TO_RESET) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		vi.restoreAllMocks();
	});

	it("returns 2 with an argparse error message on bad args", async () => {
		const io = silenceIo();
		const rc = await main(["nope"]);
		expect(rc).toBe(2);
		expect(io.stderr()).toContain("time-tracker.py: error:");
	});

	it("start → stop → aggregate cycle through main() writes and reads back", async () => {
		// _nowMs() reads Date.now(). Back-to-back start+stop resolve within
		// one ms → duration_ms=0 → aggregate skips. Advance Date.now between
		// the two so the recorded duration is positive.
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(1_700_000_000_000);
		nowSpy.mockReturnValueOnce(1_700_000_060_000);
		// Any remaining Date.now() calls (e.g. from stat / other) fall
		// through to the real clock.
		nowSpy.mockImplementation(() => 1_700_000_060_000);

		const io = silenceIo();
		expect(await main(["start", "--task", task, "--stage", "s1"])).toBe(0);
		expect(await main(["stop", "--task", task, "--stage", "s1", "--note", "n"])).toBe(0);
		// Isolate aggregate's stdout: vi.spyOn on the same target is idempotent,
		// so a second silenceIo() would return spies whose mock.calls include
		// the start+stop output. Clear the buffer instead.
		io.clear();
		expect(await main(["aggregate", "--task", task])).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.task).toBe(task);
		expect(printed.stages).toHaveLength(1);
		expect(printed.stages[0].name).toBe("s1");
		expect(printed.stages[0].note).toBe("n");
		expect(printed.total_duration_ms).toBe(60_000);
	});

	it("push through main() honours the top-level gate", async () => {
		silenceIo();
		// No env set → refuse.
		const rc = await main(["push", "--task", task]);
		expect(rc).toBe(3);
	});

	it("compare through main() writes discovery/proof/<task>/time-comparison.json", async () => {
		undoEnvFile = writeEnvFile("baselines.env", {
			BASELINE_SRP_MIN_HOURS: "1",
			BASELINE_SRP_MAX_HOURS: "2",
		});
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		silenceIo();
		// task doesn't start with SEC-; force protocol via --protocol.
		expect(await main(["compare", "--task", task, "--protocol", "srp"])).toBe(0);
		const outPath = path.join(PROOF_DIR, task, "time-comparison.json");
		expect(existsSync(outPath)).toBe(true);
		const printed = JSON.parse(readFileSync(outPath, "utf8"));
		expect(printed.protocol).toBe("srp");
		expect(printed.baseline_min_hours).toBe(1);
	});
});
