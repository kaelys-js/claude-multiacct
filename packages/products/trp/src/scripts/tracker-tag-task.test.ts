// Behavior tests for `tracker-tag-task.ts` — the TS port of
// `trp/scripts/tracker-tag-task.py`. The module exports `colourFor`,
// `loadToken`, `httpJson`, `parseArgs`, and `main`. Every external call is
// mocked here — `fetch` via `vi.stubGlobal`, `process.exit` via a spy that
// throws a marker so the exit code round-trips out to the assertion, and the
// filesystem via a per-test scratch directory. No live ClickUp traffic ever
// leaves the process.
//
// WHY it matters: `tracker-tag-task` is the tag half of the disclosure-tracker
// duo (paired with `tracker-post-proof`). If the safety gate stops refusing
// mutation on missing `TRP_ALLOW_REMOTE_MUTATE`, or `--action=create` starts
// picking a non-deterministic colour, or the token loader silently accepts an
// empty `.env.clickup`, the disclosure workflow loses one of its guardrails.
// These tests fix every exit-code branch, every argparse edge case, the
// palette-index derivation, the token-file parser, and the HTTP response
// coercion — a byte-shift in any of them trips.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { colourFor, httpJson, loadToken, main, parseArgs } from "./tracker-tag-task.ts";

// ---- shared helpers --------------------------------------------------------

// A marker error thrown by our process.exit spy. Tests that traverse a path
// which calls process.exit assert against `caught.exitCode`. Using a marker
// (rather than a plain throw) keeps intent obvious in the test log and lets
// the same helper cover both `exit(0)` and `exit(4)`.
class ExitMarker extends Error {
	exitCode: number | undefined;
	constructor(exitCode: number | undefined) {
		super(`process.exit(${String(exitCode)})`);
		this.exitCode = exitCode;
	}
}

function spyExit(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ExitMarker(code);
	}) as never);
}

// Run `fn`, returning the thrown value. Throws if `fn` doesn't throw. Used to
// pull error assertions out of a `catch` block and into the ordinary
// (unconditional) body of a test — vitest's no-conditional-expect rule flags
// `expect()` calls made from inside a `try`/`catch`.
function captureThrow(fn: () => void): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected function to throw");
}

// Build a minimal Response-shaped object. Only `.status` and `.text()` are
// touched by `httpJson`, so a duck-typed object is enough and avoids pulling
// in undici's real Response constructor (which coerces headers eagerly).
function makeResponse(status: number, body: string): Response {
	return {
		status,
		text: () => Promise.resolve(body),
	} as unknown as Response;
}

// Wrap a scripted queue of responses into a fetch double. The queue is
// consumed in order; overshooting throws so a stray call surfaces loudly
// rather than defaulting to a canned OK.
function queuedFetch(queue: Response[]): {
	fn: (...args: unknown[]) => Promise<Response>;
	calls: Array<{
		method: string | undefined;
		url: string;
		body: string | undefined;
		headers: Record<string, string>;
	}>;
} {
	const calls: Array<{
		method: string | undefined;
		url: string;
		body: string | undefined;
		headers: Record<string, string>;
	}> = [];
	let i = 0;
	const fn = (...args: unknown[]): Promise<Response> => {
		const url = String(args[0]);
		const init = (args[1] ?? {}) as {
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		};
		calls.push({
			method: init.method,
			url,
			body: init.body,
			headers: { ...init.headers },
		});
		if (i >= queue.length) {
			throw new Error(`queuedFetch: no response staged for call #${i + 1} to ${url}`);
		}
		return Promise.resolve(queue[i++]!);
	};
	return { fn, calls };
}

// ---- colourFor -------------------------------------------------------------

describe("colourFor", () => {
	// The palette itself lives inside the module; assert against the shape and
	// determinism rather than hard-coding every entry — a palette change would
	// then only need one test updated.
	const PALETTE_HEX = new Set([
		"#ef4444",
		"#f97316",
		"#eab308",
		"#22c55e",
		"#14b8a6",
		"#0ea5e9",
		"#6366f1",
		"#a855f7",
		"#ec4899",
		"#64748b",
	]);

	it("returns a [bg, fg] pair drawn from the fixed palette", () => {
		const [bg, fg] = colourFor("sec-02");
		expect(PALETTE_HEX.has(bg)).toBe(true);
		// fg is one of two contrast colours in the palette.
		expect(["#ffffff", "#1f2937"]).toContain(fg);
	});

	it("is deterministic: same name → same colour on every call", () => {
		expect(colourFor("sec-02")).toEqual(colourFor("sec-02"));
		expect(colourFor("disclosure-alpha")).toEqual(colourFor("disclosure-alpha"));
	});

	it("differs across names whose sha256 first byte mod 10 lands on a different slot", () => {
		// Empirically: 'sec-02' and 'sec-14' land on different palette slots
		// (indexes 5 and 8). Asserts the mapping still spans multiple slots
		// if the palette or hash swap out.
		expect(colourFor("sec-02")).not.toEqual(colourFor("sec-14"));
	});

	it("selects the amber slot (index 2) for a name whose sha256 first byte lands there", () => {
		// Pre-computed anchor: sha256('amber-anchor-1') first byte = 0x98 (152);
		// 152 % 10 = 2 → amber. Amber is the only slot in the palette using the
		// dark contrast colour (#1f2937), so this doubles as coverage of the
		// non-white foreground branch. Recompute if the palette order changes.
		const [bg, fg] = colourFor("amber-anchor-1");
		expect(bg).toBe("#eab308");
		expect(fg).toBe("#1f2937");
	});

	it("handles the empty string without throwing", () => {
		const [bg, fg] = colourFor("");
		expect(PALETTE_HEX.has(bg)).toBe(true);
		expect(fg).toMatch(/^#[0-9a-f]{6}$/u);
	});
});

// ---- loadToken -------------------------------------------------------------

describe("loadToken", () => {
	let scratch: string;
	let tokenPath: string;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	const savedTokenFile = process.env.CLICKUP_TOKEN_FILE;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "tracker-tag-task-"));
		tokenPath = join(scratch, ".env.clickup");
		process.env.CLICKUP_TOKEN_FILE = tokenPath;
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		exitSpy = spyExit();
	});

	afterEach(() => {
		if (savedTokenFile === undefined) {
			delete process.env.CLICKUP_TOKEN_FILE;
		} else {
			process.env.CLICKUP_TOKEN_FILE = savedTokenFile;
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function stderr(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String((c as unknown[])[0])).join("");
	}

	it("exits 4 with a not-found message when the token file is missing", () => {
		// tokenPath is never created.
		const error = captureThrow(() => {
			loadToken();
		});
		expect(error).toBeInstanceOf(ExitMarker);
		expect((error as ExitMarker).exitCode).toBe(4);
		expect(stderr()).toContain("ClickUp token file not found");
		expect(stderr()).toContain(tokenPath);
		expect(exitSpy).toHaveBeenCalledWith(4);
	});

	it("returns a bare pk_... line verbatim", () => {
		writeFileSync(tokenPath, "pk_realtoken_12345\n");
		expect(loadToken()).toBe("pk_realtoken_12345");
	});

	it("returns the value of a CLICKUP_TOKEN= line, trimmed", () => {
		writeFileSync(tokenPath, "CLICKUP_TOKEN=  pk_kv_value  \n");
		expect(loadToken()).toBe("pk_kv_value");
	});

	it("returns the value of a TOKEN= line (alias key)", () => {
		writeFileSync(tokenPath, "TOKEN=pk_alias\n");
		expect(loadToken()).toBe("pk_alias");
	});

	it("skips comments and blank lines before matching the token", () => {
		writeFileSync(
			tokenPath,
			["# this is a comment", "", "   ", "# CLICKUP_TOKEN=not-real", "pk_after_comments"].join(
				"\n",
			),
		);
		expect(loadToken()).toBe("pk_after_comments");
	});

	it("ignores unrelated KEY=VALUE lines and falls through to the pk_ literal", () => {
		writeFileSync(tokenPath, ["OTHER_ENV=whatever", "ANOTHER=xyz", "pk_fallthrough"].join("\n"));
		expect(loadToken()).toBe("pk_fallthrough");
	});

	it("exits 4 when the file exists but no token key or pk_ line is found", () => {
		writeFileSync(tokenPath, "# only comments here\n\nUNRELATED=1\n");
		const error = captureThrow(() => {
			loadToken();
		});
		expect((error as ExitMarker).exitCode).toBe(4);
		expect(stderr()).toContain("no ClickUp token found");
	});

	it("defaults CLICKUP_TOKEN_FILE to '.env.clickup' when unset", () => {
		// Unset the env var so the impl consults the default path; that default
		// is relative to cwd — point cwd at scratch so the default resolves to
		// the file we control.
		delete process.env.CLICKUP_TOKEN_FILE;
		const origCwd = process.cwd();
		try {
			process.chdir(scratch);
			writeFileSync(join(scratch, ".env.clickup"), "pk_default_path\n");
			expect(loadToken()).toBe("pk_default_path");
		} finally {
			process.chdir(origCwd);
		}
	});

	it("treats a path that is a directory as missing", () => {
		// scratch itself is a directory — pointing CLICKUP_TOKEN_FILE at it
		// exercises the `!isFile` branch through statSync's isFile()==false.
		process.env.CLICKUP_TOKEN_FILE = scratch;
		const error = captureThrow(() => {
			loadToken();
		});
		expect((error as ExitMarker).exitCode).toBe(4);
	});
});

// ---- httpJson --------------------------------------------------------------

describe("httpJson", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("sends GET without a Content-Type header when body is undefined", async () => {
		const { fn, calls } = queuedFetch([makeResponse(200, '{"ok":true}')]);
		vi.stubGlobal("fetch", fn);

		const [status, body] = await httpJson("GET", "https://api/test", "pk_x");
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true });

		expect(calls[0]!.method).toBe("GET");
		expect(calls[0]!.headers).toEqual({ Authorization: "pk_x" });
		expect(calls[0]!.body).toBeUndefined();
	});

	it("serializes the body and sets Content-Type when body is provided", async () => {
		const { fn, calls } = queuedFetch([makeResponse(201, '{"id":"new"}')]);
		vi.stubGlobal("fetch", fn);

		const [status, body] = await httpJson("POST", "https://api/create", "pk_y", {
			tag: { name: "sec-02" },
		});
		expect(status).toBe(201);
		expect(body).toEqual({ id: "new" });

		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.headers).toMatchObject({
			Authorization: "pk_y",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(calls[0]!.body!)).toEqual({ tag: { name: "sec-02" } });
	});

	it("also serializes when body is an explicit empty object (POST/apply shape)", async () => {
		const { fn, calls } = queuedFetch([makeResponse(200, '{"tagged":true}')]);
		vi.stubGlobal("fetch", fn);

		await httpJson("POST", "https://api/apply", "pk_z", {});
		expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
		expect(calls[0]!.body).toBe("{}");
	});

	it("skips serialization when body is explicitly null", async () => {
		const { fn, calls } = queuedFetch([makeResponse(200, "{}")]);
		vi.stubGlobal("fetch", fn);

		await httpJson("DELETE", "https://api/remove", "pk_d", null);
		expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
		expect(calls[0]!.body).toBeUndefined();
	});

	it("returns [status, {}] for an empty response body", async () => {
		vi.stubGlobal("fetch", queuedFetch([makeResponse(204, "")]).fn);
		const [status, body] = await httpJson("DELETE", "https://api/x", "pk_x");
		expect(status).toBe(204);
		expect(body).toEqual({});
	});

	it("wraps an array response as {value: [...]}", async () => {
		vi.stubGlobal("fetch", queuedFetch([makeResponse(200, "[1,2,3]")]).fn);
		const [status, body] = await httpJson("GET", "https://api/list", "pk_x");
		expect(status).toBe(200);
		expect(body).toEqual({ value: [1, 2, 3] });
	});

	it("wraps a primitive JSON response as {value: primitive}", async () => {
		vi.stubGlobal("fetch", queuedFetch([makeResponse(200, "42")]).fn);
		const [, body] = await httpJson("GET", "https://api/n", "pk_x");
		expect(body).toEqual({ value: 42 });
	});

	it("returns {raw} when the response body is not valid JSON", async () => {
		vi.stubGlobal("fetch", queuedFetch([makeResponse(500, "<html>oops</html>")]).fn);
		const [status, body] = await httpJson("GET", "https://api/err", "pk_x");
		expect(status).toBe(500);
		expect(body).toEqual({ raw: "<html>oops</html>" });
	});

	it("clears the abort timer even when fetch rejects", async () => {
		// If fetch throws before the timer is cleared, node keeps the timer
		// pending — the try/finally block in httpJson exists exactly to close
		// that leak. We assert the error propagates unchanged.
		vi.stubGlobal("fetch", () => {
			throw new Error("network is down");
		});
		await expect(httpJson("GET", "https://api/x", "pk_x")).rejects.toThrow("network is down");
	});
});

// ---- parseArgs -------------------------------------------------------------

describe("parseArgs", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		exitSpy = spyExit();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stderr(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String((c as unknown[])[0])).join("");
	}
	function stdout(): string {
		return stdoutSpy.mock.calls.map((c: unknown[]) => String((c as unknown[])[0])).join("");
	}

	it("parses a full valid arg list with --action, --space-id, --tag, --dry-run", () => {
		const args = parseArgs([
			"--action",
			"create",
			"--space-id",
			"90140000000",
			"--tag",
			"sec-02",
			"--dry-run",
		]);
		expect(args).toEqual({
			action: "create",
			spaceId: "90140000000",
			task: null,
			tagName: "sec-02",
			dryRun: true,
		});
	});

	it("accepts --action=list inline (equals form) without advancing i", () => {
		const args = parseArgs(["--action=list", "--space-id=90140"]);
		expect(args?.action).toBe("list");
		expect(args?.spaceId).toBe("90140");
	});

	it("treats --tag-name as an alias for --tag", () => {
		const args = parseArgs(["--action=apply", "--task", "TASK-1", "--tag-name", "sec-05"]);
		expect(args?.tagName).toBe("sec-05");
	});

	it("returns null on an invalid --action value and reports the choices", () => {
		expect(parseArgs(["--action", "burninate"])).toBeNull();
		expect(stderr()).toContain("invalid choice");
		expect(stderr()).toContain("'list'");
	});

	it("returns null when --action is missing", () => {
		expect(parseArgs(["--space-id", "90140"])).toBeNull();
		expect(stderr()).toContain("--action");
	});

	it("returns null when a flag is missing its value at the end of argv", () => {
		expect(parseArgs(["--action", "list", "--space-id"])).toBeNull();
		expect(stderr()).toContain("--space-id: expected one argument");
	});

	it("returns null when --dry-run is passed with an inline value", () => {
		expect(parseArgs(["--action=list", "--dry-run=yes"])).toBeNull();
		expect(stderr()).toContain("--dry-run");
	});

	it("returns null on an unrecognized argument", () => {
		expect(parseArgs(["--action=list", "--wat"])).toBeNull();
		expect(stderr()).toContain("unrecognized argument: --wat");
	});

	it("--help writes usage to stdout and exits 0", () => {
		const error = captureThrow(() => {
			parseArgs(["--help"]);
		});
		expect((error as ExitMarker).exitCode).toBe(0);
		expect(stdout()).toContain("usage: tracker-tag-task");
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("-h is a synonym for --help", () => {
		const error = captureThrow(() => {
			parseArgs(["-h"]);
		});
		expect((error as ExitMarker).exitCode).toBe(0);
	});

	it("populates task alone when --action=apply and only --task+--tag are given", () => {
		const args = parseArgs(["--action=remove", "--task=T-9", "--tag=sec-14"]);
		expect(args).toEqual({
			action: "remove",
			spaceId: null,
			task: "T-9",
			tagName: "sec-14",
			dryRun: false,
		});
	});
});

// ---- main ------------------------------------------------------------------

describe("main", () => {
	let scratch: string;
	let tokenPath: string;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "tracker-tag-task-main-"));
		tokenPath = join(scratch, ".env.clickup");
		writeFileSync(tokenPath, "pk_live_test\n");

		// Reset every env var the impl reads so a caller's real config can't
		// leak in and change behaviour.
		delete process.env.CLICKUP_TOKEN_FILE;
		delete process.env.CLICKUP_TEAM_ID;
		delete process.env.TRP_ALLOW_REMOTE_MUTATE;
		process.env.CLICKUP_TOKEN_FILE = tokenPath;

		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		rmSync(scratch, { recursive: true, force: true });
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function stdout(): string {
		return stdoutSpy.mock.calls.map((c: unknown[]) => String((c as unknown[])[0])).join("");
	}
	function stderr(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String((c as unknown[])[0])).join("");
	}

	// ---- parse + gate branches ---------------------------------------------

	it("returns 2 when argv is unparseable", async () => {
		expect(await main(["--action", "nope"])).toBe(2);
	});

	it("returns 3 when TRP_ALLOW_REMOTE_MUTATE is unset on a non-dry-run", async () => {
		expect(await main(["--action=list", "--space-id=1"])).toBe(3);
		expect(stderr()).toContain("refusing: TRP_ALLOW_REMOTE_MUTATE not set");
	});

	it("returns 3 when TRP_ALLOW_REMOTE_MUTATE is any value other than 'true'", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "yes";
		expect(await main(["--action=list", "--space-id=1"])).toBe(3);
	});

	it("accepts TRP_ALLOW_REMOTE_MUTATE=TRUE (case-insensitive)", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "TRUE";
		vi.stubGlobal("fetch", queuedFetch([makeResponse(200, '{"tags":[]}')]).fn);
		expect(await main(["--action=list", "--space-id=1"])).toBe(0);
	});

	// ---- list ---------------------------------------------------------------

	it("dry-run list prints the GET plan and returns 0 without hitting the network", async () => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network must not be touched on --dry-run");
		});
		expect(await main(["--action=list", "--space-id=SPX", "--dry-run"])).toBe(0);
		expect(stdout()).toContain("[DRY-RUN] GET https://api.clickup.com/api/v2/space/SPX/tag");
	});

	it("live list returns 0, prints pretty-printed JSON of the tag array", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const tags = [{ name: "sec-02" }, { name: "sec-05" }];
		vi.stubGlobal("fetch", queuedFetch([makeResponse(200, JSON.stringify({ tags }))]).fn);
		expect(await main(["--action=list", "--space-id=SP1"])).toBe(0);
		// Round-trips into the original tag list.
		expect(JSON.parse(stdout())).toEqual(tags);
	});

	it("live list returns 4 when the API returns a non-200", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		vi.stubGlobal("fetch", queuedFetch([makeResponse(401, '{"err":"unauth"}')]).fn);
		expect(await main(["--action=list", "--space-id=SP1"])).toBe(4);
		expect(stderr()).toContain("list failed: HTTP 401");
	});

	it("returns 2 when --action=list is called without --space-id", async () => {
		expect(await main(["--action=list", "--dry-run"])).toBe(2);
		expect(stderr()).toContain("--space-id is required for --action=list");
	});

	// ---- create -------------------------------------------------------------

	it("dry-run create prints the ensure plan with the derived bg/fg", async () => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network must not be touched on --dry-run");
		});
		expect(await main(["--action=create", "--space-id=SPX", "--tag=sec-02", "--dry-run"])).toBe(0);
		const [bg, fg] = colourFor("sec-02");
		expect(stdout()).toContain(
			`[DRY-RUN] would ensure tag "sec-02" in space SPX (bg=${bg} fg=${fg})`,
		);
	});

	it("live create returns 0 without POSTing when the tag already exists (idempotent)", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const { fn, calls } = queuedFetch([
			makeResponse(200, JSON.stringify({ tags: [{ name: "sec-02" }] })),
		]);
		vi.stubGlobal("fetch", fn);

		expect(await main(["--action=create", "--space-id=SP1", "--tag=sec-02"])).toBe(0);
		expect(calls).toHaveLength(1); // preflight list only, no POST
		expect(stdout()).toContain('tag "sec-02" already exists');
	});

	it("live create POSTs the tag body when the tag is absent, and returns 0", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const { fn, calls } = queuedFetch([
			makeResponse(200, JSON.stringify({ tags: [] })), // preflight list
			makeResponse(201, JSON.stringify({ ok: true })), // POST create
		]);
		vi.stubGlobal("fetch", fn);

		expect(await main(["--action=create", "--space-id=SP1", "--tag=sec-02"])).toBe(0);
		expect(calls).toHaveLength(2);
		expect(calls[1]!.method).toBe("POST");
		expect(calls[1]!.url).toBe("https://api.clickup.com/api/v2/space/SP1/tag");
		const [bg, fg] = colourFor("sec-02");
		expect(JSON.parse(calls[1]!.body!)).toEqual({
			tag: { name: "sec-02", tag_bg: bg, tag_fg: fg },
		});
		expect(stdout()).toContain(`created tag "sec-02" (bg=${bg} fg=${fg})`);
	});

	it("live create accepts a 200 (not just 201) from the create POST", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		vi.stubGlobal(
			"fetch",
			queuedFetch([
				makeResponse(200, JSON.stringify({ tags: [] })),
				makeResponse(200, JSON.stringify({ ok: true })),
			]).fn,
		);
		expect(await main(["--action=create", "--space-id=SP1", "--tag=sec-02"])).toBe(0);
	});

	it("live create returns 4 when the preflight list fails", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		vi.stubGlobal("fetch", queuedFetch([makeResponse(500, "boom")]).fn);
		expect(await main(["--action=create", "--space-id=SP1", "--tag=sec-02"])).toBe(4);
		expect(stderr()).toContain("preflight list failed: HTTP 500");
	});

	it("live create returns 4 when the POST fails, echoing the response body", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		vi.stubGlobal(
			"fetch",
			queuedFetch([
				makeResponse(200, JSON.stringify({ tags: [] })),
				makeResponse(422, JSON.stringify({ err: "bad name" })),
			]).fn,
		);
		expect(await main(["--action=create", "--space-id=SP1", "--tag=sec-02"])).toBe(4);
		expect(stderr()).toContain("create failed: HTTP 422");
		expect(stderr()).toContain("bad name");
	});

	it("returns 2 when --action=create is missing --tag-name", async () => {
		expect(await main(["--action=create", "--space-id=SP1", "--dry-run"])).toBe(2);
		expect(stderr()).toContain("--space-id and --tag-name are required");
	});

	// ---- apply --------------------------------------------------------------

	it("dry-run apply prints the POST plan with the default team_id", async () => {
		expect(await main(["--action=apply", "--task=T-1", "--tag=sec-02", "--dry-run"])).toBe(0);
		expect(stdout()).toContain(
			"[DRY-RUN] POST https://api.clickup.com/api/v2/task/T-1/tag/sec-02?custom_task_ids=true&team_id=8593845",
		);
	});

	it("dry-run apply honours CLICKUP_TEAM_ID override", async () => {
		process.env.CLICKUP_TEAM_ID = "42";
		expect(await main(["--action=apply", "--task=T-1", "--tag=sec-02", "--dry-run"])).toBe(0);
		expect(stdout()).toContain("team_id=42");
	});

	it("live apply returns 0 on HTTP 200 and prints the confirmation", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const { fn, calls } = queuedFetch([makeResponse(200, "{}")]);
		vi.stubGlobal("fetch", fn);
		expect(await main(["--action=apply", "--task=T-1", "--tag=sec-02"])).toBe(0);
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.body).toBe("{}"); // empty-object body
		expect(stdout()).toContain('applied tag "sec-02" to task T-1');
	});

	it("live apply returns 4 on non-200", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		vi.stubGlobal("fetch", queuedFetch([makeResponse(404, '{"err":"missing"}')]).fn);
		expect(await main(["--action=apply", "--task=T-1", "--tag=sec-02"])).toBe(4);
		expect(stderr()).toContain("apply failed: HTTP 404");
	});

	it("returns 2 when --action=apply is missing --task", async () => {
		expect(await main(["--action=apply", "--tag=sec-02", "--dry-run"])).toBe(2);
		expect(stderr()).toContain("--task and --tag-name are required");
	});

	// ---- remove -------------------------------------------------------------

	it("dry-run remove prints the DELETE plan", async () => {
		expect(await main(["--action=remove", "--task=T-9", "--tag=sec-14", "--dry-run"])).toBe(0);
		expect(stdout()).toContain(
			"[DRY-RUN] DELETE https://api.clickup.com/api/v2/task/T-9/tag/sec-14?custom_task_ids=true&team_id=8593845",
		);
	});

	it("live remove returns 0 on 200 and prints the confirmation", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const { fn, calls } = queuedFetch([makeResponse(200, "")]);
		vi.stubGlobal("fetch", fn);
		expect(await main(["--action=remove", "--task=T-9", "--tag=sec-14"])).toBe(0);
		expect(calls[0]!.method).toBe("DELETE");
		expect(calls[0]!.body).toBeUndefined(); // remove sends no body
		expect(stdout()).toContain('removed tag "sec-14" from task T-9');
	});

	it("live remove returns 4 on non-200", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		vi.stubGlobal("fetch", queuedFetch([makeResponse(403, '{"err":"forbidden"}')]).fn);
		expect(await main(["--action=remove", "--task=T-9", "--tag=sec-14"])).toBe(4);
		expect(stderr()).toContain("remove failed: HTTP 403");
	});

	it("returns 2 when --action=remove is missing --tag-name", async () => {
		expect(await main(["--action=remove", "--task=T-9", "--dry-run"])).toBe(2);
		expect(stderr()).toContain("--task and --tag-name are required");
	});

	// ---- integration --------------------------------------------------------

	it("end-to-end: create-then-apply flow on a fresh space with mocked ClickUp", async () => {
		// Two live sub-invocations of main() back-to-back, sharing the same
		// mock fetch queue: create finds no tag, POSTs the create, then apply
		// tags the task. This is the disclosure-tracker's real usage pattern —
		// worth pinning as a single scenario so a regression in either half
		// surfaces here before it hits an operator.
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const { fn, calls } = queuedFetch([
			makeResponse(200, JSON.stringify({ tags: [] })), // create → preflight list
			makeResponse(201, JSON.stringify({ ok: true })), // create → POST
			makeResponse(200, "{}"), // apply → POST
		]);
		vi.stubGlobal("fetch", fn);

		expect(await main(["--action=create", "--space-id=SP1", "--tag=sec-02"])).toBe(0);
		expect(await main(["--action=apply", "--task=T-42", "--tag=sec-02"])).toBe(0);

		expect(calls).toHaveLength(3);
		expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/space/SP1/tag");
		expect(calls[1]!.url).toBe("https://api.clickup.com/api/v2/space/SP1/tag");
		expect(calls[2]!.url).toContain("/task/T-42/tag/sec-02");
		expect(stdout()).toContain('created tag "sec-02"');
		expect(stdout()).toContain('applied tag "sec-02" to task T-42');
	});
});
