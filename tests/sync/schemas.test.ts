// Coverage for `scripts/sync/schemas.ts` — the vendored-schema refetcher.
//
// Two surfaces are tested. (1) The exported PURE core (`reconcile`,
// `isReachable`) is imported and unit-tested directly — no IO. (2) `main()` is
// exercised in-process through the harness with `fetch` stubbed, so the fetch →
// oxfmt-normalise → reconcile → write/check pipeline runs for real against an
// in-memory `.schemas/` tree.
//
// WHY these tests matter: this script gates schema drift in CI but MUST stay
// resilient to a flaky/offline upstream — an unreachable schema is a warning,
// NEVER drift, so an offline push can't red the gate on code the author didn't
// touch. That resilience is the subtle, load-bearing behaviour; the tests pin
// both the "real drift caught" and "unreachable ≠ drift" halves so neither can
// silently invert.

// The oxlint `vitest/no-conditional-in-test` rule flags `??` fallbacks used when
// reading back the in-memory fixture map, which are defensive defaults, not
// branching test logic — a false positive, so disabled file-wide.
/* oxlint-disable vitest/no-conditional-in-test */

import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { reconcile, isReachable, type SchemaOutcome } from "../../scripts/sync/schemas.ts";
import { runScript, resetHarness } from "./harness.ts";

const SCHEMAS = fileURLToPath(new URL("../../scripts/sync/schemas.ts", import.meta.url));

// The 13 vendored schema basenames the script fetches (SCHEMA_SOURCES keys).
const SCHEMA_NAMES = [
	"commitlint",
	"github-workflow",
	"lefthook",
	"markdownlint-cli2",
	"mise",
	"oxfmt",
	"oxlint",
	"package",
	"pnpm-workspace",
	"taplo",
	"tsconfig",
	"turbo",
	"yamllint",
];

// A mise.toml carrying the two tool pins the VERSIONED schema URLs interpolate
// (npm:oxlint drives oxlint+oxfmt; npm:markdownlint-cli2 drives markdownlint).
function miseToml(): string {
	return '[tools]\n"npm:oxlint" = "1.72.0"\n"npm:markdownlint-cli2" = "0.23.0"\n';
}

// oxfmt test double: pretty-print the piped compact JSON (tabs + trailing NL),
// which is exactly what the real `oxfmtJson` normalisation yields for equality.
function oxfmtPass(_cmd?: unknown, _args?: unknown, o?: { input?: string }): unknown {
	return {
		status: 0,
		stdout: `${JSON.stringify(JSON.parse(o?.input ?? "{}"), null, "\t")}\n`,
		stderr: "",
		signal: null,
	};
}

// The normalised on-disk form of a fetched body `raw` after the oxfmt-passthrough
// pipe — used to pre-seed `.schemas/*.json` so a --check reads as in-sync.
function normalised(raw: string): string {
	return `${JSON.stringify(JSON.parse(raw), null, "\t")}\n`;
}

// A minimal Response-like shape the schemas fetcher consumes (`ok`, `status`,
// `text()`), enough to stand in for a real fetch Response.
type FakeResponse = {
	readonly ok: boolean;
	readonly status: number;
	readonly text: () => Promise<string>;
};

// Build a fetch stub returning a fixed Response for every URL. `fetchOk` returns
// the SAME body for every URL so every vendored schema normalises to identical
// disk content (simplifies the in-sync fixture).
function fakeFetch(response: FakeResponse): typeof fetch {
	return (() => Promise.resolve(response)) as unknown as typeof fetch;
}

function fetchOk(body: string): typeof fetch {
	return fakeFetch({ ok: true, status: 200, text: () => Promise.resolve(body) });
}

afterEach(resetHarness);

describe("sync/schemas — pure reconcile/isReachable", () => {
	it("reconcile marks a formatted-upstream-differs schema as drift + toWrite, leaves matches alone", () => {
		// WHY: reconcile is the pure classifier the whole gate rests on. A reachable
		// schema whose fresh upstream differs from disk is the ONLY thing that counts
		// as drift; an identical one must not.
		const outcomes: SchemaOutcome[] = [
			{ ok: true, name: "match", path: "/s/match.json", fresh: "SAME" },
			{ ok: true, name: "drift", path: "/s/drift.json", fresh: "NEW" },
		];
		const disk = new Map([
			["/s/match.json", "SAME"],
			["/s/drift.json", "OLD"],
		]);
		const r = reconcile(outcomes, (p) => disk.get(p) ?? "");
		expect(r.drifted).toEqual(["drift"]);
		expect(r.toWrite.map((w) => w.name)).toEqual(["drift"]);
		expect(r.unreachable).toEqual([]);
		expect(r.reachableCount).toBe(2);
	});

	it("reconcile NEVER counts an unreachable schema as drift (offline-resilience invariant)", () => {
		// WHY (the load-bearing guarantee): an unreachable upstream must be collected
		// as a warning, not drift — otherwise an offline push reds the gate on a file
		// the author never changed. reachableCount excludes it.
		const outcomes: SchemaOutcome[] = [
			{ ok: false, name: "down", path: "/s/down.json", error: "ENOTFOUND" },
			{ ok: true, name: "ok", path: "/s/ok.json", fresh: "X" },
		];
		const r = reconcile(outcomes, () => "MISMATCH-BUT-IGNORED-FOR-DOWN");
		// 'down' is unreachable → collected as a warning, NEVER as drift. 'ok' fresh
		// "X" ≠ disk "MISMATCH…" → the reachable one IS drift. So drift contains ONLY
		// the reachable mismatch, proving the unreachable one was excluded.
		expect(r.drifted).toEqual(["ok"]);
		expect(r.drifted).not.toContain("down");
		expect(r.unreachable).toEqual([{ name: "down", error: "ENOTFOUND" }]);
		expect(r.toWrite.map((w) => w.name)).toEqual(["ok"]);
		expect(r.reachableCount).toBe(1);
	});

	it("isReachable narrows the outcome union by the ok flag", () => {
		// WHY: the type guard is what lets callers safely read `.fresh`; if it lied,
		// an error outcome could be treated as fetched.
		const ok: SchemaOutcome = { ok: true, name: "a", path: "/a", fresh: "f" };
		const bad: SchemaOutcome = { ok: false, name: "b", path: "/b", error: "e" };
		expect(isReachable(ok)).toBe(true);
		expect(isReachable(bad)).toBe(false);
	});
});

describe("sync/schemas — main() pipeline", () => {
	it("write mode fetches every schema, oxfmt-normalises it, and writes all 13", async () => {
		// WHY: a first-generation (or post-bump) run must vendor a fresh, formatted
		// copy of every schema so editors validate config offline.
		const files = new Map<string, string>([["mise.toml", miseToml()]]);
		vi.stubGlobal("fetch", fetchOk('{"$schema":"x"}'));
		const res = await runScript(SCHEMAS, {
			files,
			argv: [],
			entry: SCHEMAS,
			spawnSync: oxfmtPass,
		});
		expect(res.exitCode).toBeUndefined();
		expect(res.stdout).toContain("Schemas synced.");
		for (const name of SCHEMA_NAMES) {
			expect(res.stdout, `must write ${name}`).toContain(`Wrote .schemas/${name}.json.`);
		}
		expect(res.writes).toHaveLength(SCHEMA_NAMES.length);
	});

	it("--check passes (exit 0) and reports N/N verified when every vendored copy matches upstream", async () => {
		// WHY: the drift gate must be green when the repo is in sync, or it gets
		// disabled. reachableCount==names.length yields the 'verified' message.
		const body = '{"$schema":"x","title":"t"}';
		const files = new Map<string, string>([["mise.toml", miseToml()]]);
		for (const name of SCHEMA_NAMES) {
			files.set(`.schemas/${name}.json`, normalised(body));
		}
		vi.stubGlobal("fetch", fetchOk(body));
		const res = await runScript(SCHEMAS, {
			files,
			argv: ["--check"],
			entry: SCHEMAS,
			spawnSync: oxfmtPass,
		});
		expect(res.exitCode).toBeUndefined();
		expect(res.stdout).toContain(`Schemas are in sync (13/13 verified).`);
	});

	it("--check FAILS (exit 1) naming each schema whose vendored copy drifted from upstream", async () => {
		// WHY: a stale vendored schema must be caught — that IS the gate. Disk is left
		// empty (reads as "") so every fetched schema is drift.
		const body = '{"changed":true}';
		const files = new Map<string, string>([["mise.toml", miseToml()]]);
		vi.stubGlobal("fetch", fetchOk(body));
		const res = await runScript(SCHEMAS, {
			files,
			argv: ["--check"],
			entry: SCHEMAS,
			spawnSync: oxfmtPass,
		});
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain(".schemas/oxlint.json is out of sync with upstream.");
		expect(res.stderr).toContain("Run `pnpm sync:schemas` to fix.");
		expect(res.writes).toEqual([]); // --check never writes
	});

	it("a non-2xx upstream becomes an unreachable WARNING, not drift (HTTP error path)", async () => {
		// WHY: a 5xx / 404 from SchemaStore must degrade to a warning so a flaky
		// upstream can't fail the gate. fetchText throws on !res.ok → error outcome.
		const files = new Map<string, string>([["mise.toml", miseToml()]]);
		const badFetch = fakeFetch({ ok: false, status: 503, text: () => Promise.resolve("") });
		vi.stubGlobal("fetch", badFetch);
		const res = await runScript(SCHEMAS, {
			files,
			argv: ["--check"],
			entry: SCHEMAS,
			spawnSync: oxfmtPass,
		});
		// Every upstream 503 → all unreachable → reachableCount 0 → the offline msg,
		// exit 0 (NOT a drift failure).
		expect(res.exitCode).toBeUndefined();
		expect(res.stderr).toContain("HTTP 503");
		expect(res.stderr).toContain("upstream unreachable");
		expect(res.stdout).toContain("all upstreams unreachable — drift check skipped");
	});

	it("a thrown fetch (network down) becomes an unreachable warning, never drift", async () => {
		// WHY: DNS failure / offline throws from fetch itself. fetchSchema must catch
		// it into an error outcome so the whole sync doesn't reject.
		const files = new Map<string, string>([["mise.toml", miseToml()]]);
		const throwingFetch = (() =>
			Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch;
		vi.stubGlobal("fetch", throwingFetch);
		const res = await runScript(SCHEMAS, {
			files,
			argv: [],
			entry: SCHEMAS,
			spawnSync: oxfmtPass,
		});
		expect(res.exitCode).toBeUndefined();
		expect(res.stderr).toContain("ENOTFOUND");
		// Nothing written — all upstreams were unreachable.
		expect(res.writes).toEqual([]);
		expect(res.stdout).toContain("Schemas synced.");
	});

	it("an oxfmt failure on a fetched body degrades that schema to an unreachable warning", async () => {
		// WHY: oxfmtJson throws when the formatter exits non-zero; fetchSchema catches
		// it as an error outcome (resilient), so a broken formatter can't crash sync —
		// it surfaces as a per-schema warning instead.
		const files = new Map<string, string>([["mise.toml", miseToml()]]);
		vi.stubGlobal("fetch", fetchOk('{"ok":1}'));
		const res = await runScript(SCHEMAS, {
			files,
			argv: ["--check"],
			entry: SCHEMAS,
			spawnSync: () => ({ status: 1, stdout: "", stderr: "oxfmt exploded", signal: null }),
		});
		expect(res.exitCode).toBeUndefined();
		expect(res.stderr).toContain("oxfmt failed");
		expect(res.stdout).toContain("all upstreams unreachable — drift check skipped");
	});

	it("a versioned schema whose tool pin is ABSENT from mise.toml degrades to a warning (readToolVersion throw)", async () => {
		// WHY: the oxlint/oxfmt/markdownlint schema URLs interpolate a tool version
		// read from mise.toml's [tools]. If that pin is missing, readToolVersion throws
		// `no [tools] entry` — fetchSchema catches it into an error outcome so a
		// misconfigured mise.toml warns per-schema rather than crashing the whole sync.
		// This mise.toml has a [tools] table (with a decoy [env]) but NONE of the three
		// versioned pins, so oxlint/oxfmt/markdownlint-cli2 all surface the throw.
		const files = new Map<string, string>([
			["mise.toml", '[env]\nfoo = "bar"\n[tools]\nnode = "22.0.0"\n'],
		]);
		vi.stubGlobal("fetch", fetchOk('{"ok":1}'));
		const res = await runScript(SCHEMAS, {
			files,
			argv: ["--check"],
			entry: SCHEMAS,
			spawnSync: oxfmtPass,
		});
		// The three versioned schemas warn with the readToolVersion message; the
		// unversioned SchemaStore ones still fetch fine.
		expect(res.stderr).toContain('no [tools] entry for "npm:oxlint"');
		expect(res.stderr).toContain("upstream unreachable");
		// Not all upstreams are down (SchemaStore ones succeed), so this is a normal
		// verified-count check, not the all-offline branch — exit 0 here since disk
		// happens to equal the fetched body for the reachable ones? No: disk is empty,
		// so the reachable ones ARE drift → exit 1. Pin that the throw path is a
		// WARNING regardless of the overall drift verdict.
		expect(res.exitCode).toBe(1);
	});

	it("a malformed (non-JSON) upstream body degrades to an unreachable warning (parse guard)", async () => {
		// WHY: oxfmtJson parses first so a junk download fails loudly rather than
		// vendoring garbage; that parse throw is caught into an error outcome.
		const files = new Map<string, string>([["mise.toml", miseToml()]]);
		const junkFetch = fakeFetch({
			ok: true,
			status: 200,
			text: () => Promise.resolve("<html>not json</html>"),
		});
		vi.stubGlobal("fetch", junkFetch);
		const res = await runScript(SCHEMAS, {
			files,
			argv: [],
			entry: SCHEMAS,
			spawnSync: oxfmtPass,
		});
		expect(res.exitCode).toBeUndefined();
		expect(res.stderr).toContain("upstream unreachable");
		expect(res.writes).toEqual([]);
	});
});
