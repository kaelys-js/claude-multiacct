// Behaviour tests for `tracker-fetch-task.ts` (TRP polymorphic task fetcher).
//
// WHY it matters: this port is a byte-for-byte re-implementation of the
// Python source at `security-pocs/repos/trp/scripts/tracker-fetch-task.py`.
// Downstream stages (design, patch, verify) key off the normalised task
// record's field names, so any drift in status/priority coercion, mock
// dispatch, custom-id detection, comment/attachment shape normalisation,
// or slug canonicalisation poisons every stage that reads the file. The
// module also touches `process.exit` via `die()` and the network via
// `fetch` — every failure path has to be exercised with those stubbed so
// the tests can never hit a live ClickUp tenant.
//
// External calls (`fetch`, `process.exit`, stderr/stdout writes) are
// stubbed per-test via `vi.stubGlobal` / `vi.spyOn`. Token files are
// written to a per-test tmpdir and addressed via a REPO_ROOT-relative
// path (path.join normalises the `..` segments).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	clickupGet,
	fetchClickup,
	loadClickupToken,
	main,
	normaliseClickup,
	parseTaskArg,
	readTokenFile,
	slugify,
} from "./tracker-fetch-task.ts";

// Matches the impl's `dirname(dirname(import.meta.filename))` — both files
// live in `<pkg>/src/scripts/`, so REPO_ROOT resolves to `<pkg>/src`.
const REPO_ROOT = dirname(import.meta.dirname);

const EXIT_ENV_VARS = [
	"CLICKUP_TOKEN_FILE",
	"TRP_ALLOW_FALLBACK_TOKEN",
	"TRP_FALLBACK_TOKEN_DIR",
	"CLICKUP_TEAM_ID",
	"TRACKER_TYPE",
	"TRP_MOCK",
	"TRP_MOCK_FIXTURE",
] as const;

function stubExit(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`__exit_${code ?? 0}__`);
	}) as never);
}

function stubStderr(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

function stubStdout(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

// These small helpers exist so call sites inside `it()` bodies read a spy's
// captured args without an inline `??`/`?.` — oxlint's no-conditional-in-test
// rule flags conditional expressions written directly in a test body, but has
// no objection to the same logic hoisted into a plain function.
function callArgAt(spy: ReturnType<typeof vi.spyOn>, index: number): string {
	return String(spy.mock.calls[index]?.[0] ?? "");
}

function lastCallArg(spy: ReturnType<typeof vi.spyOn>): string {
	return String(spy.mock.calls.at(-1)?.[0] ?? "");
}

function joinedCallArgs(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("");
}

// Hoisted to module scope (rather than nested in the "live-API" describe
// block it originally lived in) since it captures nothing from that block's
// closure — an oxlint unicorn/consistent-function-scoping requirement.
function stubApiSequence(
	responses: Array<{ status: number; body: string | object }>,
): ReturnType<typeof vi.fn> {
	let i = 0;
	const fetchFn = vi.fn<() => Response>(() => {
		const step = responses[i++] ?? { status: 200, body: "{}" };
		const body = typeof step.body === "string" ? step.body : JSON.stringify(step.body);
		return new Response(body, { status: step.status });
	});
	vi.stubGlobal("fetch", fetchFn);
	return fetchFn;
}

// ────────────────────────────────────────────────────────────────────────
// parseTaskArg — the tiny splitter fronting the polymorphic dispatcher.
// A regression here silently routes a ClickUp id to the Linear stub.
// ────────────────────────────────────────────────────────────────────────

describe("parseTaskArg", () => {
	it("returns [null, value] when no colon is present (env-only fallback)", () => {
		expect(parseTaskArg("HAND_ITC-308")).toEqual([null, "HAND_ITC-308"]);
	});

	it("splits TRACKER:ID and lowercases the tracker", () => {
		expect(parseTaskArg("ClickUp:HAND_ITC-308")).toEqual(["clickup", "HAND_ITC-308"]);
	});

	it("trims whitespace around both halves", () => {
		expect(parseTaskArg("  clickup  :  HAND_ITC-308  ")).toEqual(["clickup", "HAND_ITC-308"]);
	});

	it("returns tracker=null when the tracker half is empty (': task')", () => {
		expect(parseTaskArg(":solo")).toEqual([null, "solo"]);
	});

	it("splits only on the first colon (task ids can contain ':')", () => {
		expect(parseTaskArg("linear:PROJ:123")).toEqual(["linear", "PROJ:123"]);
	});
});

// ────────────────────────────────────────────────────────────────────────
// readTokenFile — token disk-parse. Bare pk_/KEY=VALUE/quoted-value.
// ────────────────────────────────────────────────────────────────────────

describe("readTokenFile", () => {
	let scratch: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "tracker-fetch-token-"));
		exitSpy = stubExit();
		stderrSpy = stubStderr();
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns a bare pk_ line verbatim", () => {
		const p = join(scratch, "t");
		writeFileSync(p, "pk_abc123\n");
		expect(readTokenFile(p)).toBe("pk_abc123");
	});

	it("returns the value from CLICKUP_TOKEN=…", () => {
		const p = join(scratch, "t");
		writeFileSync(p, "# a comment\nCLICKUP_TOKEN=pk_from_env\n");
		expect(readTokenFile(p)).toBe("pk_from_env");
	});

	it("returns the value from TOKEN=… (secondary key)", () => {
		const p = join(scratch, "t");
		writeFileSync(p, "TOKEN=pk_secondary\n");
		expect(readTokenFile(p)).toBe("pk_secondary");
	});

	it("strips surrounding double-quotes from the value", () => {
		const p = join(scratch, "t");
		writeFileSync(p, 'CLICKUP_TOKEN="pk_quoted"\n');
		expect(readTokenFile(p)).toBe("pk_quoted");
	});

	it("strips surrounding single-quotes from the value", () => {
		const p = join(scratch, "t");
		writeFileSync(p, "CLICKUP_TOKEN='pk_single'\n");
		expect(readTokenFile(p)).toBe("pk_single");
	});

	it("skips blank lines, comment lines, and unrelated KEY=VALUE lines", () => {
		const p = join(scratch, "t");
		writeFileSync(
			p,
			[
				"",
				"# a comment",
				"OTHER=irrelevant",
				"KEY_WITHOUT_TOKEN=nope",
				"CLICKUP_TOKEN=pk_wins",
			].join("\n"),
		);
		expect(readTokenFile(p)).toBe("pk_wins");
	});

	it("dies with an exit-2 when the file contains no usable token line", () => {
		const p = join(scratch, "t");
		writeFileSync(p, "# just a header\nOTHER=nope\nCLICKUP_TOKEN=\n");
		expect(() => readTokenFile(p)).toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(callArgAt(stderrSpy, 0)).toContain("no ClickUp token found");
	});

	it("dies with an exit-2 when the file cannot be read", () => {
		const p = join(scratch, "missing");
		expect(() => readTokenFile(p)).toThrow("__exit_2__");
		expect(callArgAt(stderrSpy, 0)).toContain("no ClickUp token found");
	});
});

// ────────────────────────────────────────────────────────────────────────
// loadClickupToken (primary path). The fallback branch requires a fresh
// module-load with TRP_FALLBACK_TOKEN_DIR set — tested separately below.
// ────────────────────────────────────────────────────────────────────────

describe("loadClickupToken (primary path)", () => {
	let scratch: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of EXIT_ENV_VARS) {
			savedEnv[k] = process.env[k];
		}
		for (const k of EXIT_ENV_VARS) {
			Reflect.deleteProperty(process.env, k);
		}
		scratch = mkdtempSync(join(tmpdir(), "tracker-fetch-primary-"));
		exitSpy = stubExit();
		stderrSpy = stubStderr();
	});

	afterEach(() => {
		for (const k of EXIT_ENV_VARS) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("reads the primary token when CLICKUP_TOKEN_FILE points at a real file", () => {
		const abs = join(scratch, "primary-env");
		writeFileSync(abs, "pk_primary\n");
		process.env.CLICKUP_TOKEN_FILE = relative(REPO_ROOT, abs);
		expect(loadClickupToken()).toBe("pk_primary");
	});

	it("defaults CLICKUP_TOKEN_FILE to '.env.clickup' relative to REPO_ROOT", () => {
		// The default resolves under `<pkg>/src/.env.clickup`, which does not
		// exist in this workspace. Without a fallback dir configured, this
		// short-circuits to die() — proving the default is what we think it is.
		expect(() => loadClickupToken()).toThrow("__exit_2__");
		expect(lastCallArg(stderrSpy)).toContain(join(REPO_ROOT, ".env.clickup"));
	});

	it("dies loudly when the primary is missing and the fallback flag is off", () => {
		process.env.CLICKUP_TOKEN_FILE = "no/such/env.clickup";
		process.env.TRP_ALLOW_FALLBACK_TOKEN = "false";
		expect(() => loadClickupToken()).toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
	});

	it("dies loudly when the fallback flag is on but no TRP_FALLBACK_TOKEN_DIR is set at module load", () => {
		// FALLBACK_TOKEN_DIR is captured once at import; this test file did NOT
		// set the env var before its top-level import, so the constant is null
		// and the fallback branch short-circuits without ever touching disk.
		process.env.CLICKUP_TOKEN_FILE = "no/such/env.clickup";
		process.env.TRP_ALLOW_FALLBACK_TOKEN = "true";
		expect(() => loadClickupToken()).toThrow("__exit_2__");
	});
});

// ────────────────────────────────────────────────────────────────────────
// loadClickupToken fallback path — needs a fresh module-load with
// TRP_FALLBACK_TOKEN_DIR set BEFORE import, so we vi.resetModules() and
// dynamic-import a fresh copy.
// ────────────────────────────────────────────────────────────────────────

describe("loadClickupToken (fallback, dynamic module reload)", () => {
	let scratch: string;
	let fallbackDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of EXIT_ENV_VARS) {
			savedEnv[k] = process.env[k];
		}
		for (const k of EXIT_ENV_VARS) {
			Reflect.deleteProperty(process.env, k);
		}
		scratch = mkdtempSync(join(tmpdir(), "tracker-fetch-fallback-"));
		fallbackDir = mkdtempSync(join(tmpdir(), "tracker-fetch-fallback-dir-"));
	});

	afterEach(() => {
		for (const k of EXIT_ENV_VARS) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		rmSync(scratch, { recursive: true, force: true });
		rmSync(fallbackDir, { recursive: true, force: true });
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("reads the fallback token when primary missing + allow=true + dir set + fallback file exists", async () => {
		writeFileSync(join(fallbackDir, ".env.clickup"), "pk_fallback_wins\n");
		process.env.TRP_FALLBACK_TOKEN_DIR = fallbackDir;
		process.env.TRP_ALLOW_FALLBACK_TOKEN = "true";
		process.env.CLICKUP_TOKEN_FILE = "no/such/primary";
		vi.resetModules();
		const stderrSpy = stubStderr();
		// vitest-only module-reset cache-buster; TS can't resolve the query suffix.
		// @ts-expect-error runtime import; TS 5.x cannot type module-query suffixes.
		const mod = await import("./tracker-fetch-task.ts?fresh=fallback-ok");
		expect(mod.loadClickupToken()).toBe("pk_fallback_wins");
		// The NOTE line about using the fallback lands on stderr.
		const notes = joinedCallArgs(stderrSpy);
		expect(notes).toContain("using fallback token at");
	});

	it("dies when primary missing + allow=true + dir set but fallback file also missing", async () => {
		// Do NOT create fallback file — the fallback existsSync() returns false,
		// so we fall through to die().
		process.env.TRP_FALLBACK_TOKEN_DIR = fallbackDir;
		process.env.TRP_ALLOW_FALLBACK_TOKEN = "true";
		process.env.CLICKUP_TOKEN_FILE = "no/such/primary";
		vi.resetModules();
		const exitSpy = stubExit();
		stubStderr();
		// vitest-only module-reset cache-buster; TS can't resolve the query suffix.
		// @ts-expect-error runtime import; TS 5.x cannot type module-query suffixes.
		const mod = await import("./tracker-fetch-task.ts?fresh=fallback-missing");
		expect(() => mod.loadClickupToken()).toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
	});
});

// ────────────────────────────────────────────────────────────────────────
// clickupGet — the fetch wrapper. Stub globalThis.fetch and Response.
// ────────────────────────────────────────────────────────────────────────

describe("clickupGet", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = stubExit();
		stderrSpy = stubStderr();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("issues a GET with Authorization + Accept headers and returns parsed JSON", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, init: RequestInit) => {
				seen.url = url;
				seen.init = init;
				return new Response('{"ok": 1, "id": "T-1"}', { status: 200 });
			}),
		);
		const result = await clickupGet("/task/T-1", "pk_x");
		expect(result).toEqual({ ok: 1, id: "T-1" });
		expect(seen.url).toBe("https://api.clickup.com/api/v2/task/T-1");
		expect(seen.init?.method).toBe("GET");
		const headers = seen.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("pk_x");
		expect(headers.Accept).toBe("application/json");
	});

	it("URL-encodes query params when passed a non-null query record", async () => {
		const seen: { url?: string } = {};
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				seen.url = url;
				return new Response("{}", { status: 200 });
			}),
		);
		await clickupGet("/task/T-1", "pk_x", {
			custom_task_ids: "true",
			team_id: "42",
		});
		expect(seen.url).toContain("?custom_task_ids=true&team_id=42");
	});

	it("returns {} when the body is empty (JSON.parse('' || '{}') branch)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Response("", { status: 200 })),
		);
		expect(await clickupGet("/task/T-1", "pk_x")).toEqual({});
	});

	it("dies with exit-2 when the response is non-2xx", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Response("nope", { status: 404 })),
		);
		await expect(clickupGet("/task/T-1", "pk_x")).rejects.toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
		const stderrText = joinedCallArgs(stderrSpy);
		expect(stderrText).toContain("ClickUp GET /task/T-1");
		expect(stderrText).toContain("404");
	});

	it("dies with exit-2 when fetch itself throws (network / abort)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("ECONNREFUSED");
			}),
		);
		await expect(clickupGet("/task/T-1", "pk_x")).rejects.toThrow("__exit_2__");
		const stderrText = joinedCallArgs(stderrSpy);
		expect(stderrText).toContain("ECONNREFUSED");
	});
});

// ────────────────────────────────────────────────────────────────────────
// fetchClickup — mock-fixture path first, then live-API path with fetch
// stubbed. Every shape-normalisation branch is covered.
// ────────────────────────────────────────────────────────────────────────

describe("fetchClickup (mock-fixture path)", () => {
	let scratch: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "tracker-fetch-mock-"));
		exitSpy = stubExit();
		stderrSpy = stubStderr();
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("unpacks task/comments/attachments when the fixture has all three keys", async () => {
		const p = join(scratch, "m.json");
		writeFileSync(
			p,
			JSON.stringify({
				task: { id: "T-1", name: "hello" },
				comments: [{ id: "c1" }],
				attachments: [{ id: "a1" }],
			}),
		);
		const [task, comments, attachments] = await fetchClickup("T-1", p);
		expect(task).toEqual({ id: "T-1", name: "hello" });
		expect(comments).toEqual([{ id: "c1" }]);
		expect(attachments).toEqual([{ id: "a1" }]);
	});

	it("defaults comments/attachments to [] when the fixture omits them", async () => {
		const p = join(scratch, "m.json");
		writeFileSync(p, JSON.stringify({ task: { id: "T-1" } }));
		const [task, comments, attachments] = await fetchClickup("T-1", p);
		expect(task).toEqual({ id: "T-1" });
		expect(comments).toEqual([]);
		expect(attachments).toEqual([]);
	});

	it("treats a fixture without a 'task' key as the task itself", async () => {
		const p = join(scratch, "m.json");
		writeFileSync(p, JSON.stringify({ id: "T-2", name: "bare" }));
		const [task] = await fetchClickup("T-2", p);
		expect(task).toEqual({ id: "T-2", name: "bare" });
	});

	it("coerces non-array comments/attachments in the fixture to []", async () => {
		const p = join(scratch, "m.json");
		writeFileSync(
			p,
			JSON.stringify({
				task: { id: "T-1" },
				comments: "not-an-array",
				attachments: { nope: true },
			}),
		);
		const [, comments, attachments] = await fetchClickup("T-1", p);
		expect(comments).toEqual([]);
		expect(attachments).toEqual([]);
	});

	it("dies with exit-2 when the mock fixture path does not exist", async () => {
		await expect(fetchClickup("T-1", join(scratch, "missing.json"))).rejects.toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(callArgAt(stderrSpy, 0)).toContain("mock fixture not found");
	});

	it("dies with exit-2 when the mock fixture is not valid JSON", async () => {
		const p = join(scratch, "m.json");
		writeFileSync(p, "not json {{");
		await expect(fetchClickup("T-1", p)).rejects.toThrow("__exit_2__");
		expect(callArgAt(stderrSpy, 0)).toContain("not valid JSON");
	});
});

describe("fetchClickup (live-API path, fetch stubbed)", () => {
	let scratch: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of EXIT_ENV_VARS) {
			savedEnv[k] = process.env[k];
		}
		for (const k of EXIT_ENV_VARS) {
			Reflect.deleteProperty(process.env, k);
		}
		scratch = mkdtempSync(join(tmpdir(), "tracker-fetch-live-"));
		// Point the token loader at a valid file so we don't die() before fetch.
		const tokenAbs = join(scratch, "token");
		writeFileSync(tokenAbs, "pk_live\n");
		process.env.CLICKUP_TOKEN_FILE = relative(REPO_ROOT, tokenAbs);
		exitSpy = stubExit();
		stderrSpy = stubStderr();
	});

	afterEach(() => {
		for (const k of EXIT_ENV_VARS) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("dies when a custom id is used but CLICKUP_TEAM_ID is unset", async () => {
		stubApiSequence([]); // fetch should never fire
		await expect(fetchClickup("HAND_ITC-308")).rejects.toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(callArgAt(stderrSpy, 0)).toContain("looks like a custom id");
	});

	it("adds custom_task_ids + team_id when CLICKUP_TEAM_ID is set + id is custom-shaped", async () => {
		process.env.CLICKUP_TEAM_ID = "9000";
		const fetchFn = stubApiSequence([
			{ status: 200, body: { id: "HAND_ITC-308", name: "custom" } },
			{ status: 200, body: { comments: [{ id: "c1" }] } },
			{ status: 200, body: { attachments: [{ id: "a1" }] } },
		]);
		const [task, comments, attachments] = await fetchClickup("HAND_ITC-308");
		expect(task).toEqual({ id: "HAND_ITC-308", name: "custom" });
		expect(comments).toEqual([{ id: "c1" }]);
		expect(attachments).toEqual([{ id: "a1" }]);
		expect(fetchFn).toHaveBeenCalledTimes(3);
		// Every URL is wearing the same team/custom query.
		for (const call of fetchFn.mock.calls) {
			const url = String(call[0]);
			expect(url).toContain("custom_task_ids=true");
			expect(url).toContain("team_id=9000");
		}
	});

	it("does NOT add the custom-id query for a pure-numeric ClickUp short id", async () => {
		const fetchFn = stubApiSequence([
			{ status: 200, body: { id: "12345", name: "short" } },
			{ status: 200, body: { comments: [] } },
			{ status: 200, body: { attachments: [] } },
		]);
		await fetchClickup("12345");
		for (const call of fetchFn.mock.calls) {
			expect(String(call[0])).not.toContain("custom_task_ids");
		}
	});

	it("normalises /comment shape: {comments:[...]} → array", async () => {
		stubApiSequence([
			{ status: 200, body: { id: "1" } },
			{ status: 200, body: { comments: [{ id: "c1" }, { id: "c2" }] } },
			{ status: 200, body: { attachments: [] } },
		]);
		const [, comments] = await fetchClickup("1");
		expect(comments).toEqual([{ id: "c1" }, { id: "c2" }]);
	});

	it("normalises /comment shape: bare array response → array", async () => {
		stubApiSequence([
			{ status: 200, body: { id: "1" } },
			{ status: 200, body: [{ id: "c1" }] },
			{ status: 200, body: [] },
		]);
		const [, comments] = await fetchClickup("1");
		expect(comments).toEqual([{ id: "c1" }]);
	});

	it("normalises /comment shape: {comments: <non-array>} → []", async () => {
		stubApiSequence([
			{ status: 200, body: { id: "1" } },
			{ status: 200, body: { comments: "junk" } },
			{ status: 200, body: [] },
		]);
		const [, comments] = await fetchClickup("1");
		expect(comments).toEqual([]);
	});

	it("normalises /attachment shape: {attachments:[...]}", async () => {
		stubApiSequence([
			{ status: 200, body: { id: "1" } },
			{ status: 200, body: [] },
			{ status: 200, body: { attachments: [{ id: "a1" }] } },
		]);
		const result = await fetchClickup("1");
		const attachments = result.at(2);
		expect(attachments).toEqual([{ id: "a1" }]);
	});

	it("normalises /attachment shape: {data:[...]} (fallback key)", async () => {
		stubApiSequence([
			{ status: 200, body: { id: "1" } },
			{ status: 200, body: [] },
			{ status: 200, body: { data: [{ id: "a1" }] } },
		]);
		const result = await fetchClickup("1");
		const attachments = result.at(2);
		expect(attachments).toEqual([{ id: "a1" }]);
	});

	it("normalises /attachment shape: dict with neither attachments nor data → []", async () => {
		stubApiSequence([
			{ status: 200, body: { id: "1" } },
			{ status: 200, body: [] },
			{ status: 200, body: { irrelevant: true } },
		]);
		const result = await fetchClickup("1");
		const attachments = result.at(2);
		expect(attachments).toEqual([]);
	});

	it("normalises /attachment shape: bare array", async () => {
		stubApiSequence([
			{ status: 200, body: { id: "1" } },
			{ status: 200, body: [] },
			{ status: 200, body: [{ id: "a1" }] },
		]);
		const result = await fetchClickup("1");
		const attachments = result.at(2);
		expect(attachments).toEqual([{ id: "a1" }]);
	});
});

// ────────────────────────────────────────────────────────────────────────
// normaliseClickup — every branch of the field coercion.
// ────────────────────────────────────────────────────────────────────────

describe("normaliseClickup", () => {
	it("copies scalar fields onto the normalised record", () => {
		const rec = normaliseClickup(
			{
				id: "T-1",
				name: "hello",
				text_content: "body",
				url: "https://ex/T-1",
				date_updated: "2026-07-12",
			},
			[],
			[],
		);
		expect(rec.task_id).toBe("T-1");
		expect(rec.title).toBe("hello");
		expect(rec.description).toBe("body");
		expect(rec.url).toBe("https://ex/T-1");
		expect(rec.updated_at).toBe("2026-07-12");
	});

	it("falls back from text_content to description when text_content is missing", () => {
		const rec = normaliseClickup({ description: "d only" }, [], []);
		expect(rec.description).toBe("d only");
	});

	it("prefers text_content over description when both are present", () => {
		const rec = normaliseClickup({ text_content: "TC", description: "d" }, [], []);
		expect(rec.description).toBe("TC");
	});

	it("unpacks dict-shaped status into {status, type}", () => {
		const rec = normaliseClickup({ status: { status: "in progress", type: "custom" } }, [], []);
		expect(rec.status).toEqual({ status: "in progress", type: "custom" });
	});

	it("falls through string-shaped status as-is with type=null", () => {
		const rec = normaliseClickup({ status: "just-a-string" }, [], []);
		expect(rec.status).toEqual({ status: "just-a-string", type: null });
	});

	it("handles null status via ?? {} (behaves like empty dict)", () => {
		const rec = normaliseClickup({ status: null }, [], []) as {
			status: { status: unknown; type: unknown };
		};
		// null ?? {} = {}, statusIsObj = true, empty object → both undefined,
		// which JSON.stringify would drop. We just check that .status doesn't
		// leak the raw null through.
		expect(rec.status.status).toBeUndefined();
		expect(rec.status.type).toBeUndefined();
	});

	it("unpacks dict-shaped priority into {priority}", () => {
		const rec = normaliseClickup({ priority: { priority: "high", color: "red" } }, [], []);
		expect(rec.priority).toEqual({ priority: "high" });
	});

	it("falls through string-shaped priority as-is", () => {
		const rec = normaliseClickup({ priority: "urgent" }, [], []);
		expect(rec.priority).toEqual({ priority: "urgent" });
	});

	it("maps assignees to {id, username, email}", () => {
		const rec = normaliseClickup(
			{
				assignees: [
					{ id: 1, username: "alice", email: "a@x", other: "drop" },
					{ id: 2, username: "bob", email: "b@x" },
				],
			},
			[],
			[],
		) as { assignees: Array<Record<string, unknown>> };
		expect(rec.assignees).toEqual([
			{ id: 1, username: "alice", email: "a@x" },
			{ id: 2, username: "bob", email: "b@x" },
		]);
	});

	it("defaults assignees to [] when the task has none", () => {
		const rec = normaliseClickup({}, [], []) as {
			assignees: unknown[];
			subtasks: unknown;
			custom_fields: unknown;
		};
		expect(rec.assignees).toEqual([]);
		expect(rec.subtasks).toEqual([]);
		expect(rec.custom_fields).toEqual([]);
	});

	it("preserves custom_fields and subtasks verbatim when present", () => {
		const cf = [{ id: "f1", name: "sev" }];
		const st = [{ id: "sub1" }];
		const rec = normaliseClickup({ custom_fields: cf, subtasks: st }, [], []) as {
			custom_fields: unknown;
			subtasks: unknown;
		};
		expect(rec.custom_fields).toBe(cf);
		expect(rec.subtasks).toBe(st);
	});

	it("maps comments including the nested user.username lookup", () => {
		const rec = normaliseClickup(
			{},
			[
				{
					id: "c1",
					user: { username: "alice" },
					date: "1",
					comment_text: "hi",
				},
				{ id: "c2", user: null, date: "2", comment_text: "later" },
				{ id: "c3", date: "3", comment_text: "no user field" },
			],
			[],
		) as {
			comments: Array<Record<string, unknown>>;
		};
		// Python's `(c.get("user") or {}).get("username")` returns None for
		// the null-user and missing-user branches, which JSON-serialises as
		// `null` — not a dropped key. The TS port lands `null` on both
		// branches so the parity fixture byte-matches the Python original.
		expect(rec.comments).toEqual([
			{ id: "c1", user: "alice", date: "1", text: "hi" },
			{ id: "c2", user: null, date: "2", text: "later" },
			{ id: "c3", user: null, date: "3", text: "no user field" },
		]);
	});

	it("maps attachments to {id, title, url, extension}", () => {
		const rec = normaliseClickup(
			{},
			[],
			[
				{
					id: "a1",
					title: "screenshot.png",
					url: "https://ex/a1",
					extension: "png",
					other: "drop",
				},
			],
		) as { attachments: Array<Record<string, unknown>> };
		expect(rec.attachments).toEqual([
			{ id: "a1", title: "screenshot.png", url: "https://ex/a1", extension: "png" },
		]);
	});

	it("preserves the raw payload under _raw for downstream forensic use", () => {
		const task = { id: "T-1", name: "hi" };
		const comments = [{ id: "c1" }];
		const attachments = [{ id: "a1" }];
		const rec = normaliseClickup(task, comments, attachments) as {
			["_raw"]: { task: unknown; comments: unknown; attachments: unknown };
		};
		expect(rec["_raw"].task).toBe(task);
		expect(rec["_raw"].comments).toBe(comments);
		expect(rec["_raw"].attachments).toBe(attachments);
	});
});

// ────────────────────────────────────────────────────────────────────────
// slugify — cosmetic but load-bearing (downstream file paths key off it).
// ────────────────────────────────────────────────────────────────────────

describe("slugify", () => {
	it("lowercases and preserves underscores/hyphens", () => {
		expect(slugify("HAND_ITC-308")).toBe("hand_itc-308");
	});

	it("replaces runs of non-slug chars with a single hyphen", () => {
		expect(slugify("abc def")).toBe("abc-def");
		expect(slugify("a b   c")).toBe("a-b-c");
	});

	it("strips leading and trailing hyphens", () => {
		expect(slugify("---abc---")).toBe("abc");
	});

	it("returns an empty string for input that collapses to nothing", () => {
		expect(slugify("---")).toBe("");
		expect(slugify("")).toBe("");
	});
});

// ────────────────────────────────────────────────────────────────────────
// main() — integration via the mock-fixture path (no fetch involved).
// ────────────────────────────────────────────────────────────────────────

describe("main() integration", () => {
	let scratch: string;
	let outDir: string;
	let mockPath: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of EXIT_ENV_VARS) {
			savedEnv[k] = process.env[k];
		}
		for (const k of EXIT_ENV_VARS) {
			Reflect.deleteProperty(process.env, k);
		}
		scratch = mkdtempSync(join(tmpdir(), "tracker-fetch-main-"));
		outDir = join(scratch, "discovery");
		mockPath = join(scratch, "fixture.json");
		exitSpy = stubExit();
		stderrSpy = stubStderr();
		stdoutSpy = stubStdout();
	});

	afterEach(() => {
		for (const k of EXIT_ENV_VARS) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function writeStandardFixture(): void {
		writeFileSync(
			mockPath,
			JSON.stringify({
				task: {
					id: "HAND_ITC-308",
					name: "example title",
					text_content: "body",
					status: { status: "in progress", type: "custom" },
					priority: { priority: "high" },
					assignees: [{ id: 42, username: "alice", email: "a@x" }],
					custom_fields: [{ id: "cf1" }],
					subtasks: [],
					date_updated: "1751500000000",
					url: "https://app.clickup.com/t/HAND_ITC-308",
				},
				comments: [
					{
						id: "c1",
						user: { username: "reviewer" },
						date: "1",
						comment_text: "please explain",
					},
				],
				attachments: [{ id: "a1", title: "shot.png", url: "https://ex/a1", extension: "png" }],
			}),
		);
	}

	it("end-to-end: --task clickup:… --mock --out-dir writes discovery/task-<slug>.json", async () => {
		writeStandardFixture();
		await main(["--task", "clickup:HAND_ITC-308", "--mock", mockPath, "--out-dir", outDir]);
		const outPath = join(outDir, "task-hand_itc-308.json");
		expect(existsSync(outPath)).toBe(true);
		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.task_id).toBe("HAND_ITC-308");
		expect(payload.title).toBe("example title");
		expect(payload.status).toEqual({ status: "in progress", type: "custom" });
		expect(payload.priority).toEqual({ priority: "high" });
		expect(payload.assignees).toEqual([{ id: 42, username: "alice", email: "a@x" }]);
		expect(payload.comments[0]).toEqual({
			id: "c1",
			user: "reviewer",
			date: "1",
			text: "please explain",
		});
		// The tail newline is part of the write contract.
		expect(readFileSync(outPath, "utf8").endsWith("\n")).toBe(true);
		// stdout should carry the out-path.
		const stdoutText = joinedCallArgs(stdoutSpy);
		expect(stdoutText).toContain(outPath);
	});

	it("supports the --task=VALUE and --out-dir=VALUE equals forms", async () => {
		writeStandardFixture();
		await main([`--task=clickup:HAND_ITC-308`, `--mock=${mockPath}`, `--out-dir=${outDir}`]);
		expect(existsSync(join(outDir, "task-hand_itc-308.json"))).toBe(true);
	});

	it("falls back to TRACKER_TYPE env when --task has no colon prefix", async () => {
		process.env.TRACKER_TYPE = "clickup";
		writeStandardFixture();
		await main(["--task", "HAND_ITC-308", "--mock", mockPath, "--out-dir", outDir]);
		expect(existsSync(join(outDir, "task-hand_itc-308.json"))).toBe(true);
	});

	it("honours TRP_MOCK=true + TRP_MOCK_FIXTURE=<path> as an alternative to --mock", async () => {
		writeStandardFixture();
		process.env.TRP_MOCK = "true";
		process.env.TRP_MOCK_FIXTURE = mockPath;
		await main(["--task", "clickup:HAND_ITC-308", "--out-dir", outDir]);
		expect(existsSync(join(outDir, "task-hand_itc-308.json"))).toBe(true);
	});

	it("dies with exit-2 when TRP_MOCK=true but no fixture is configured", async () => {
		process.env.TRP_MOCK = "true";
		await expect(main(["--task", "clickup:HAND_ITC-308", "--out-dir", outDir])).rejects.toThrow(
			"__exit_2__",
		);
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(joinedCallArgs(stderrSpy)).toContain("TRP_MOCK=true");
	});

	it("dies with exit-2 when no tracker is specified in arg or env", async () => {
		writeStandardFixture();
		await expect(
			main(["--task", "HAND_ITC-308", "--mock", mockPath, "--out-dir", outDir]),
		).rejects.toThrow("__exit_2__");
		expect(joinedCallArgs(stderrSpy)).toContain("no tracker specified");
	});

	it("dies with exit-2 when the tracker string is unknown", async () => {
		writeStandardFixture();
		await expect(
			main(["--task", "notatracker:x", "--mock", mockPath, "--out-dir", outDir]),
		).rejects.toThrow("__exit_2__");
		expect(joinedCallArgs(stderrSpy)).toContain("unknown tracker");
	});

	it.each(["linear", "jira", "github-issue"])(
		"throws NotImplementedError-style Error for tracker=%s (not exit)",
		async (tracker) => {
			writeStandardFixture();
			await expect(
				main(["--task", `${tracker}:whatever`, "--mock", mockPath, "--out-dir", outDir]),
			).rejects.toThrow(new RegExp(`tracker '${tracker}' is not implemented`, "u"));
			// die() was never called for these — this branch throws instead.
			expect(exitSpy).not.toHaveBeenCalled();
		},
	);

	it("creates a nested --out-dir when it does not yet exist", async () => {
		writeStandardFixture();
		const nested = join(scratch, "a", "b", "c", "discovery");
		await main(["--task", "clickup:HAND_ITC-308", "--mock", mockPath, "--out-dir", nested]);
		expect(existsSync(join(nested, "task-hand_itc-308.json"))).toBe(true);
	});

	// ── argparse error paths ──

	it("--task is required (exit 2 when missing)", async () => {
		await expect(main([])).rejects.toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(joinedCallArgs(stderrSpy)).toContain("--task");
	});

	it("unrecognized flags exit 2 with a usage line on stderr", async () => {
		await expect(main(["--nope"])).rejects.toThrow("__exit_2__");
		expect(exitSpy).toHaveBeenCalledWith(2);
		const stderrText = joinedCallArgs(stderrSpy);
		expect(stderrText).toContain("unrecognized argument: --nope");
	});

	it("-h prints the usage banner and exits 0", async () => {
		await expect(main(["-h"])).rejects.toThrow("__exit_0__");
		expect(exitSpy).toHaveBeenCalledWith(0);
		const stdoutText = joinedCallArgs(stdoutSpy);
		expect(stdoutText).toContain("usage:");
		expect(stdoutText).toContain("Fetch a tracker task");
	});

	it("--help behaves the same as -h", async () => {
		await expect(main(["--help"])).rejects.toThrow("__exit_0__");
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	// `mkdirSync` is idempotent — a re-run against a pre-existing dir must not
	// crash. This exercises the `{recursive: true}` fast path.
	it("does not throw when --out-dir already exists", async () => {
		writeStandardFixture();
		mkdirSync(outDir, { recursive: true });
		await main(["--task", "clickup:HAND_ITC-308", "--mock", mockPath, "--out-dir", outDir]);
		expect(existsSync(join(outDir, "task-hand_itc-308.json"))).toBe(true);
	});
});
