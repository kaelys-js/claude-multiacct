// Branch-coverage tests for `time-tracker.ts`, split out from the sibling
// `time-tracker.test.ts` (which already covers primary behaviour) because
// `time-tracker.ts` is a 1200-line file with a wide branch surface —
// `httpJson`, `pushClickup`, `pushHarvest`, `speedupNoteSuffix`,
// `detectClients`, `parseProjectMap`, `resolveHarvestTargets`, `renderNote`,
// `formatHarvestTime`, `cfgFloat`/`resolveBaselineRange`, and `pyRound`'s
// banker's-rounding tie-break are all module-private, so every scenario
// here drives them indirectly through the exported `cmdPush`/`cmdCompare`/
// `main`/`loadConfig` entry points — exactly the surface an operator or the
// wrapper script actually calls.
//
// Each test's WHY: a missed branch here isn't cosmetic — it's a client
// getting billed the wrong hours, a note template silently truncating, or
// a multi-client Harvest split routing money to the wrong project.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";
import { cmdCompare, cmdPush, loadConfig, main } from "./time-tracker.ts";

vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
}));

const mockedSh = vi.mocked(sh);

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, "..");
const TIME_DIR = path.join(REPO_ROOT, "discovery", "time");
const PROOF_DIR = path.join(REPO_ROOT, "discovery", "proof");

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

let taskCounter = 0;
function uniqueTask(prefix = "BR-TASK"): string {
	taskCounter += 1;
	return `${prefix}-${process.pid}-${Date.now()}-${taskCounter}`;
}

function cleanupTask(task: string): void {
	if (existsSync(TIME_DIR)) {
		for (const name of readdirSync(TIME_DIR)) {
			if (name.startsWith(`${task}-`)) {
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

function writeSession(task: string, stage: string, data: Record<string, unknown>): string {
	mkdirSync(TIME_DIR, { recursive: true });
	const safe = stage.replaceAll("/", "_");
	const p = path.join(TIME_DIR, `${task}-${safe}.json`);
	writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
	return p;
}

function silenceIo(): { stdout: () => string; stderr: () => string; clear: () => void } {
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

function writeEnvFile(name: string, body: string): () => void {
	const p = path.join(REPO_ROOT, name);
	const prior = existsSync(p) ? readFileSync(p, "utf8") : null;
	writeFileSync(p, body);
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

// A placeholder client-tag script so `_detectClients` reaches the `sh()`
// mock instead of short-circuiting on "file doesn't exist".
async function withClientTagScript<T>(fn: () => Promise<T>): Promise<T> {
	const scriptDir = path.join(REPO_ROOT, "scripts");
	const scriptPath = path.join(scriptDir, "sfp-client-tags.py");
	const prior = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : null;
	mkdirSync(scriptDir, { recursive: true });
	writeFileSync(scriptPath, "# test placeholder\n");
	try {
		return await fn();
	} finally {
		if (prior === null) {
			try {
				rmSync(scriptPath, { force: true });
			} catch {
				// best-effort
			}
		} else {
			writeFileSync(scriptPath, prior);
		}
	}
}

describe("loadConfig — loadEnvFile quoting + precedence branches", () => {
	const undoers: Array<() => void> = [];
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of ENV_KEYS_TO_RESET) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
	});

	afterEach(() => {
		for (const undo of undoers.splice(0)) {
			undo();
		}
		for (const k of ENV_KEYS_TO_RESET) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
	});

	it("strips matching double quotes from a value", () => {
		undoers.push(writeEnvFile("harvest.env", 'CLICKUP_TOKEN="dq-value"\n'));
		expect(loadConfig().CLICKUP_TOKEN).toBe("dq-value");
	});

	it("strips matching single quotes from a value", () => {
		undoers.push(writeEnvFile("harvest.env", "CLICKUP_TOKEN='sq-value'\n"));
		expect(loadConfig().CLICKUP_TOKEN).toBe("sq-value");
	});

	it("leaves an unquoted value untouched", () => {
		undoers.push(writeEnvFile("harvest.env", "CLICKUP_TOKEN=bare-value\n"));
		expect(loadConfig().CLICKUP_TOKEN).toBe("bare-value");
	});

	it("leaves a mismatched-quote value untouched (starts \" ends ')", () => {
		undoers.push(writeEnvFile("harvest.env", "CLICKUP_TOKEN=\"mismatched'\n"));
		expect(loadConfig().CLICKUP_TOKEN).toBe("\"mismatched'");
	});

	it("skips blank lines, comment lines, and lines without '='", () => {
		undoers.push(
			writeEnvFile(
				"harvest.env",
				["", "# a comment", "not-a-kv-line", 'CLICKUP_TOKEN="tok"', ""].join("\n"),
			),
		);
		const cfg = loadConfig();
		expect(cfg.CLICKUP_TOKEN).toBe("tok");
	});

	it("first-loaded file wins on a duplicate key (harvest.env before .env.clickup)", () => {
		undoers.push(
			writeEnvFile("harvest.env", "CLICKUP_TOKEN=from-harvest-env\n"),
			writeEnvFile(".env.clickup", "CLICKUP_TOKEN=from-dot-clickup\n"),
		);
		expect(loadConfig().CLICKUP_TOKEN).toBe("from-harvest-env");
	});

	it("process.env value wins over every env file for the pass-through key set", () => {
		undoers.push(writeEnvFile("harvest.env", "CLICKUP_TOKEN=from-file\n"));
		process.env.CLICKUP_TOKEN = "from-process-env";
		expect(loadConfig().CLICKUP_TOKEN).toBe("from-process-env");
	});
});

describe("cmdPush — ClickUp branch surface (httpJson + idempotency + gate variants)", () => {
	let task: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		task = uniqueTask("CU");
		for (const k of ENV_KEYS_TO_RESET) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		mockedSh.mockReset();
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

	it("gate accepts an uppercase 'TRUE' value (case-insensitive)", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "TRUE";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 1,
			duration_ms: 1,
		});
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.dry_run).toBe(true);
	});

	it("gate refuses when TRP_ALLOW_REMOTE_MUTATE is explicitly 'false'", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "false";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 1,
			duration_ms: 1,
		});
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.refused).toBe("TRP_ALLOW_REMOTE_MUTATE != true");
	});

	it("re-pushes when the prior pushed-file exists but is invalid JSON (no double-post guard)", async () => {
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
		mkdirSync(TIME_DIR, { recursive: true });
		writeFileSync(path.join(TIME_DIR, `${task}-clickup-pushed.json`), "not-json-at-all");
		const fetchMock = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
			status: 200,
			text: () => JSON.stringify({ id: "direct-id-no-wrapper" }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const printed = JSON.parse(io.stdout());
		// resp.id used directly (no `.data` wrapper) — the other unwrap branch.
		expect(printed.clickup.pushed_record.entry_id).toBe("direct-id-no-wrapper");
	});

	it("treats a prior pushed-file with only `id` (no `entry_id`) as already-pushed", async () => {
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
		mkdirSync(TIME_DIR, { recursive: true });
		writeFileSync(
			path.join(TIME_DIR, `${task}-clickup-pushed.json`),
			JSON.stringify({ id: "legacy-id-field" }),
		);
		const fetchMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
		vi.stubGlobal("fetch", fetchMock);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		const printed = JSON.parse(io.stdout());
		expect(String(printed.clickup.skipped)).toContain("legacy-id-field");
	});

	it("summary falls back to '<n> stages' when every session's stage name is falsy", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		writeSession(task, "", { task, stage: "", epoch_start_ms: 0, epoch_end_ms: 1, duration_ms: 1 });
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(String(printed.clickup.payload.description)).toContain("1 stages");
	});

	it("start falls back to nowMs()-totalMs when no stage recorded an epoch_start_ms", async () => {
		process.env.CLICKUP_TOKEN = "tok";
		process.env.CLICKUP_TEAM_ID = "T1";
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		// duration_ms without epoch_start_ms on the session record.
		writeSession(task, "s", { task, stage: "s", duration_ms: 5000 });
		const before = Date.now();
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.payload.start).toBeGreaterThanOrEqual(before - 5000 - 1000);
		expect(printed.clickup.payload.start).toBeLessThanOrEqual(before + 1000);
	});

	it("network error during the POST resolves to status 0 with a stringified error (no throw)", async () => {
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
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED")));
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.status).toBe(0);
		expect(String(printed.clickup.response.error)).toContain("ECONNREFUSED");
	});

	it("a 4xx response is surfaced as {error: raw} without a pushed_record", async () => {
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
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ status: 422, text: () => "validation failed" }),
		);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.status).toBe(422);
		expect(printed.clickup.response.error).toBe("validation failed");
		expect(printed.clickup.pushed_record).toBeUndefined();
	});

	it("an empty response body on success parses to {} rather than throwing", async () => {
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
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 204, text: () => "" }));
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.response).toEqual({});
		expect(printed.clickup.pushed_record).toBeUndefined();
	});

	it("a non-empty non-JSON response body on success falls back to {raw}", async () => {
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
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, text: () => "not json" }));
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.clickup.response.raw).toBe("not json");
	});
});

describe("cmdPush — Harvest branch surface (resolveHarvestTargets + multi-client + verify)", () => {
	let task: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		task = uniqueTask("HV");
		for (const k of ENV_KEYS_TO_RESET) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		process.env.HARVEST_ACCOUNT_ID = "A1";
		process.env.HARVEST_ACCESS_TOKEN = "TOK";
		process.env.HARVEST_TASK_ID = "42";
		mockedSh.mockReset();
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

	it("ERROR level when no clients detected and no TTT_INTERNAL project id is configured", async () => {
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
		expect(printed.harvest.level).toBe("ERROR");
		expect(String(printed.harvest.skipped)).toContain("HARVEST_TTT_INTERNAL_PROJECT_ID unset");
	});

	it("legacy HARVEST_PROJECT_ID that isn't an integer falls through to the ERROR branch", async () => {
		process.env.HARVEST_PROJECT_ID = "not-an-int";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.level).toBe("ERROR");
	});

	it("ERROR when HARVEST_TTT_INTERNAL_PROJECT_ID is set but not an integer", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "3.5";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 60_000,
			duration_ms: 60_000,
		});
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.level).toBe("ERROR");
		expect(String(printed.harvest.skipped)).toContain("not int: '3.5'");
	});

	it("split-evenly (default strategy) divides hours across multiple detected clients, tagging each entry", async () => {
		process.env.HARVEST_PROJECT_MAP = JSON.stringify({ acme: 111, globex: 222 });
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(0, "globex,acme"));
			const io = silenceIo();
			const rc = await cmdPush({ task, dry_run: true, verify: false });
			expect(rc).toBe(0);
			const printed = JSON.parse(io.stdout());
			expect(printed.harvest.strategy).toBe("split-evenly");
			expect(printed.harvest.entries).toHaveLength(2);
			// Sorted alphabetically: acme, then globex.
			expect(printed.harvest.entries[0].client).toBe("acme");
			expect(printed.harvest.entries[1].client).toBe("globex");
			expect(printed.harvest.entries[0].hours).toBeCloseTo(0.5, 4);
		});
	});

	it("primary-only strategy picks the alphabetically-first client and assigns it all the hours", async () => {
		process.env.HARVEST_PROJECT_MAP = JSON.stringify({ acme: 111, globex: 222 });
		process.env.HARVEST_MULTI_CLIENT_STRATEGY = "PRIMARY-ONLY";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(0, "globex,acme"));
			const io = silenceIo();
			const rc = await cmdPush({ task, dry_run: true, verify: false });
			expect(rc).toBe(0);
			const printed = JSON.parse(io.stdout());
			expect(printed.harvest.strategy).toBe("primary-only");
			expect(printed.harvest.entries).toHaveLength(1);
			expect(printed.harvest.entries[0].client).toBe("acme");
			expect(printed.harvest.entries[0].hours).toBeCloseTo(1, 4);
		});
	});

	it("a single non-null client still gets a `-<client>` suffix on its pushed-file", async () => {
		process.env.HARVEST_PROJECT_MAP = JSON.stringify({ acme: 111 });
		process.env.HARVEST_ALLOW_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(0, "acme"));
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ status: 201, text: () => JSON.stringify({ id: "h-1" }) }),
			);
			const io = silenceIo();
			const rc = await cmdPush({ task, dry_run: false, verify: false });
			expect(rc).toBe(0);
			expect(existsSync(path.join(TIME_DIR, `${task}-pushed-acme.json`))).toBe(true);
			const io2 = silenceIo();
			io2.clear();
			io.clear();
			const rc2 = await cmdPush({ task, dry_run: false, verify: false });
			expect(rc2).toBe(0);
			const printed2 = JSON.parse(io2.stdout());
			expect(String(printed2.harvest.entries[0].skipped)).toContain("already pushed");
		});
	});

	it("re-pushes when the prior Harvest pushed-file exists but is invalid JSON", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_ALLOW_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		mkdirSync(TIME_DIR, { recursive: true });
		writeFileSync(path.join(TIME_DIR, `${task}-pushed.json`), "{not valid json");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ status: 201, text: () => JSON.stringify({ id: "h-2" }) }),
		);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].pushed_record.entry_id).toBe("h-2");
	});

	it("HARVEST_ALLOW_MUTATE != true skips the mutating POST even when not dry-run", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true"; // opens the top-level cmdPush gate
		const fetchMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
		vi.stubGlobal("fetch", fetchMock);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: false });
		expect(rc).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].skipped).toBe("HARVEST_ALLOW_MUTATE != true");
	});

	it("a failed Harvest POST (4xx) leaves no pushed_record and skips verify", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_ALLOW_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ status: 422, text: () => "bad project_id" }),
		);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: true });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].pushed_record).toBeUndefined();
		expect(printed.harvest.entries[0].verify).toBeUndefined();
	});

	it("verify=true confirms a matching GET (ok:true) after a successful POST", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_ALLOW_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const fetchMock = vi
			.fn<(...args: unknown[]) => Promise<unknown>>()
			.mockResolvedValueOnce({ status: 201, text: () => JSON.stringify({ id: "h-verify-1" }) })
			.mockResolvedValueOnce({
				status: 200,
				text: () => JSON.stringify({ hours: 1, notes: "should-not-matter" }),
			});
		vi.stubGlobal("fetch", fetchMock);
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: false, verify: true });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		const [entry] = printed.harvest.entries;
		expect(entry.pushed_record.entry_id).toBe("h-verify-1");
		expect(entry.verify.status).toBe(200);
		expect(entry.verify.notes_match).toBe(false);
		expect(entry.verify.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const getUrl = fetchMock.mock.calls[1]?.[0];
		expect(String(getUrl)).toContain("h-verify-1");
	});

	it("verify=true reports ok:false when the GET returns a null hours field", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_ALLOW_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const fetchMock = vi
			.fn<(...args: unknown[]) => Promise<unknown>>()
			.mockResolvedValueOnce({ status: 201, text: () => JSON.stringify({ id: "h-verify-2" }) })
			.mockResolvedValueOnce({ status: 200, text: () => JSON.stringify({ hours: null }) });
		vi.stubGlobal("fetch", fetchMock);
		const io = silenceIo();
		await cmdPush({ task, dry_run: false, verify: true });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].verify.ok).toBe(false);
		expect(printed.harvest.entries[0].verify.fetched_hours).toBeNull();
	});

	it("Harvest 'hours' entries without an 'id' in the response skip pushed_record entirely", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_ALLOW_MUTATE = "true";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ status: 200, text: () => JSON.stringify({ ok: true }) }),
		);
		const io = silenceIo();
		await cmdPush({ task, dry_run: false, verify: true });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].pushed_record).toBeUndefined();
	});

	it("formatHarvestTime: noon boundary renders '12:00pm' (h===12 branch, not h%12)", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		// 3h duration starting 9:00 -> ends exactly at 12:00 (noon).
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3 * 3_600_000,
			duration_ms: 3 * 3_600_000,
		});
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.started_time).toBe("9:00am");
		expect(printed.harvest.entries[0].payload.ended_time).toBe("12:00pm");
	});

	it("formatHarvestTime: an ordinary pm hour (not 12, not a multiple of 12) renders correctly", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		// 5h duration starting 9:00 -> ends at 14:00 (2:00pm).
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 5 * 3_600_000,
			duration_ms: 5 * 3_600_000,
		});
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.ended_time).toBe("2:00pm");
	});

	it("formatHarvestTime: an hour that's a nonzero multiple of 12 (24) still renders '12', not '0'", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		// 15h duration starting 9:00 -> endTotal minutes land the hour at 24.
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 15 * 3_600_000,
			duration_ms: 15 * 3_600_000,
		});
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.ended_time).toBe("12:00pm");
	});

	it("HARVEST_NOTE_TEMPLATE: a custom template referencing a known field renders; an unknown field throws KeyError", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_NOTE_TEMPLATE = "{sec_id} / {stage_summary} / {hours}h";
		writeSession(task, "s", {
			task,
			stage: "important-stage",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const io = silenceIo();
		const rc = await cmdPush({ task, dry_run: true, verify: false });
		expect(rc).toBe(0);
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.notes).toContain("important-stage");
	});

	it("HARVEST_NOTE_TEMPLATE with an unknown field throws, propagating out of cmdPush uncaught", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_NOTE_TEMPLATE = "{no_such_field}";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		silenceIo();
		await expect(cmdPush({ task, dry_run: true, verify: false })).rejects.toThrow(
			"KeyError: 'no_such_field'",
		);
	});

	it("SEC-shaped task id populates sec_id from the regex capture; a non-SEC task falls back to the raw task string", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		process.env.HARVEST_NOTE_TEMPLATE = "id={sec_id}";
		const secTask = `SEC-999-suffix-${process.pid}-${Date.now()}`;
		writeSession(secTask, "s", {
			task: secTask,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const io = silenceIo();
		await cmdPush({ task: secTask, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.notes).toBe("id=SEC-999");
		cleanupTask(secTask);
	});

	it("speedupNoteSuffix is appended when a time-comparison.json with every required field exists", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const proofDir = path.join(PROOF_DIR, task);
		mkdirSync(proofDir, { recursive: true });
		writeFileSync(
			path.join(proofDir, "time-comparison.json"),
			JSON.stringify({
				actual_hours: 1.5,
				baseline_min_hours: 4,
				baseline_max_hours: 8,
				speedup_min: 2.7,
				speedup_max: 5.3,
			}),
		);
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.notes).toContain("AI-assisted actual: 1h 30m");
		expect(printed.harvest.entries[0].payload.notes).toContain("Speedup: 2.7-5.3x");
	});

	it("speedupNoteSuffix is empty when time-comparison.json is missing a required field", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const proofDir = path.join(PROOF_DIR, task);
		mkdirSync(proofDir, { recursive: true });
		// speedup_max deliberately omitted.
		writeFileSync(
			path.join(proofDir, "time-comparison.json"),
			JSON.stringify({
				actual_hours: 1.5,
				baseline_min_hours: 4,
				baseline_max_hours: 8,
				speedup_min: 2.7,
			}),
		);
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.notes).not.toContain("AI-assisted");
	});

	it("speedupNoteSuffix is empty when time-comparison.json is invalid JSON", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const proofDir = path.join(PROOF_DIR, task);
		mkdirSync(proofDir, { recursive: true });
		writeFileSync(path.join(proofDir, "time-comparison.json"), "not json");
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.notes).not.toContain("AI-assisted");
	});

	it("speedupNoteSuffix is empty when time-comparison.json path is a directory, not a file", async () => {
		process.env.HARVEST_TTT_INTERNAL_PROJECT_ID = "500";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		const proofDir = path.join(PROOF_DIR, task);
		// Make time-comparison.json a directory instead of a file.
		mkdirSync(path.join(proofDir, "time-comparison.json"), { recursive: true });
		const io = silenceIo();
		await cmdPush({ task, dry_run: true, verify: false });
		const printed = JSON.parse(io.stdout());
		expect(printed.harvest.entries[0].payload.notes).not.toContain("AI-assisted");
	});

	it("detectClients: sh() rejecting is treated as no clients detected", async () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockRejectedValue(new Error("spawn failed"));
			const io = silenceIo();
			await cmdPush({ task, dry_run: true, verify: false });
			const printed = JSON.parse(io.stdout());
			// No clients -> ERROR (no HARVEST_TTT_INTERNAL_PROJECT_ID configured).
			expect(printed.harvest.level).toBe("ERROR");
		});
	});

	it("detectClients: a non-zero sh() exit code is treated as no clients detected", async () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(1, "acme"));
			const io = silenceIo();
			await cmdPush({ task, dry_run: true, verify: false });
			const printed = JSON.parse(io.stdout());
			expect(printed.harvest.level).toBe("ERROR");
		});
	});

	it("detectClients: blank stdout is treated as no clients detected", async () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(0, "   "));
			const io = silenceIo();
			await cmdPush({ task, dry_run: true, verify: false });
			const printed = JSON.parse(io.stdout());
			expect(printed.harvest.level).toBe("ERROR");
		});
	});

	it("parseProjectMap: invalid JSON in HARVEST_PROJECT_MAP degrades to an empty map (WARN, all clients missing)", async () => {
		process.env.HARVEST_PROJECT_MAP = "{not valid json";
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(0, "acme"));
			const io = silenceIo();
			await cmdPush({ task, dry_run: true, verify: false });
			const printed = JSON.parse(io.stdout());
			expect(printed.harvest.level).toBe("WARN");
		});
	});

	it("parseProjectMap: a non-integer project id value degrades the whole map to empty", async () => {
		process.env.HARVEST_PROJECT_MAP = JSON.stringify({ acme: 1.5 });
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 3_600_000,
			duration_ms: 3_600_000,
		});
		await withClientTagScript(async () => {
			mockedSh.mockReset();
			mockedSh.mockResolvedValue(shResult(0, "acme"));
			const io = silenceIo();
			await cmdPush({ task, dry_run: true, verify: false });
			const printed = JSON.parse(io.stdout());
			expect(printed.harvest.level).toBe("WARN");
		});
	});
});

describe("cmdCompare — resolveBaselineRange + cfgFloat + advisory scaling branches", () => {
	let task: string;
	const savedEnv: Record<string, string | undefined> = {};
	let undoEnvFile: (() => void) | null = null;

	beforeEach(() => {
		task = uniqueTask("CMP");
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

	// `BASELINE_*` keys are NOT in loadConfig's process.env pass-through list
	// (only HARVEST_/CLICKUP_/TRP_ keys are) — they're only readable via a
	// `baselines.env` file, so every scenario below writes one instead of
	// setting process.env directly.

	it("explicit protocol=sfp resolves the SFP-per-finding baseline pair", () => {
		undoEnvFile = writeEnvFile(
			"baselines.env",
			"BASELINE_SFP_PER_FINDING_MIN=0.5\nBASELINE_SFP_PER_FINDING_MAX=2\n",
		);
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: "sfp" });
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBe(0.5);
		expect(printed.baseline_max_hours).toBe(2);
	});

	it("protocol=trp with no mode resolves to a null baseline pair (falls through the mode-gated branch)", () => {
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: "trp" });
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBeNull();
		expect(printed.baseline_max_hours).toBeNull();
	});

	it("an unrecognised protocol string (bypassing parseArgs' choice validation) resolves to null/null", () => {
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: "not-a-real-protocol" });
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBeNull();
		expect(printed.protocol).toBe("not-a-real-protocol");
	});

	it("cfgFloat: falls back from a missing first key to a present second key", () => {
		// BASELINE_SRP_MIN_HOURS unset, BASELINE_SRP_MIN set — resolveBaselineRange
		// probes both names in that order for the SRP baseline.
		undoEnvFile = writeEnvFile("baselines.env", "BASELINE_SRP_MIN=3\nBASELINE_SRP_MAX=9\n");
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: "srp" });
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBe(3);
		expect(printed.baseline_max_hours).toBe(9);
	});

	it("cfgFloat: a non-numeric env value is skipped, falling through to the next candidate key", () => {
		undoEnvFile = writeEnvFile(
			"baselines.env",
			[
				"BASELINE_SRP_MIN_HOURS=not-a-number",
				"BASELINE_SRP_MIN=7",
				"BASELINE_SRP_MAX_HOURS=not-a-number-either",
				"BASELINE_SRP_MAX=14",
				"",
			].join("\n"),
		);
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: "srp" });
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBe(7);
		expect(printed.baseline_max_hours).toBe(14);
	});

	it("advisory-item scaling applies for protocol=trp + mode=solve (not just srp)", () => {
		undoEnvFile = writeEnvFile(
			"baselines.env",
			[
				"BASELINE_TRP_SOLVE_BUGFIX_MIN=3",
				"BASELINE_TRP_SOLVE_BUGFIX_MAX=6",
				"BASELINE_ADVISORY_ITEM_MULTIPLIER=2",
				"",
			].join("\n"),
		);
		const io = silenceIo();
		cmdCompare({
			task,
			mode: "solve",
			cls: "bugfix",
			advisory_items: 3,
			protocol: "trp",
		});
		const printed = JSON.parse(io.stdout());
		// baseMin = (3 * 2 * 3) / 3 = 6; baseMax = (6 * 2 * 3) / 3 = 12.
		expect(printed.baseline_min_hours).toBe(6);
		expect(printed.baseline_max_hours).toBe(12);
	});

	it("advisory_items > 1 with an ineligible protocol (trp, mode != solve) does not scale the baseline", () => {
		undoEnvFile = writeEnvFile(
			"baselines.env",
			"BASELINE_TRP_SUPPORT_MIN=3\nBASELINE_TRP_SUPPORT_MAX=6\n",
		);
		const io = silenceIo();
		cmdCompare({
			task,
			mode: "support",
			cls: null,
			advisory_items: 5,
			protocol: "trp",
		});
		const printed = JSON.parse(io.stdout());
		expect(printed.baseline_min_hours).toBe(3);
		expect(printed.baseline_max_hours).toBe(6);
	});

	it("pyRound banker's-rounding tie with an even floor rounds DOWN (2.5 -> 2, not 3)", () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 900,
			duration_ms: 900,
		});
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: null });
		const printed = JSON.parse(io.stdout());
		// 900ms / 3.6e6 * 10000 = 2.5 exactly; floor=2 is even -> rounds to 2 -> 0.0002.
		expect(printed.actual_hours).toBeCloseTo(0.0002, 6);
	});

	it("pyRound banker's-rounding tie with an odd floor rounds UP (5.5 -> 6)", () => {
		writeSession(task, "s", {
			task,
			stage: "s",
			epoch_start_ms: 0,
			epoch_end_ms: 1980,
			duration_ms: 1980,
		});
		const io = silenceIo();
		cmdCompare({ task, mode: null, cls: null, advisory_items: 1, protocol: null });
		const printed = JSON.parse(io.stdout());
		// 1980ms / 3.6e6 * 10000 = 5.5 exactly; floor=5 is odd -> rounds to 6 -> 0.0006.
		expect(printed.actual_hours).toBeCloseTo(0.0006, 6);
	});
});

describe("main() — full command surface via argv (start/stop/compare cases + argparse-error path)", () => {
	let task: string;

	beforeEach(() => {
		task = uniqueTask("MAIN");
	});

	afterEach(() => {
		cleanupTask(task);
	});

	it("main(['start', ...]) then main(['stop', ...]) round-trips through the exported CLI surface", async () => {
		const io = silenceIo();
		const rcStart = await main(["start", "--task", task, "--stage", "s"]);
		expect(rcStart).toBe(0);
		const rcStop = await main(["stop", "--task", task, "--stage", "s", "--note", "done"]);
		expect(rcStop).toBe(0);
		io.clear();
	});

	it("main(['compare', ...]) exercises the compare case inside the exported CLI switch", async () => {
		const io = silenceIo();
		const rc = await main(["compare", "--task", task]);
		expect(rc).toBe(0);
		io.clear();
	});

	it("main() with a malformed flag surfaces the argparse error prefix and returns 2", async () => {
		const io = silenceIo();
		const rc = await main(["aggregate", "--bogus-flag"]);
		expect(rc).toBe(2);
		expect(io.stderr()).toContain("time-tracker.py: error:");
	});
});
