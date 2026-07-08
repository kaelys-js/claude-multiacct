// In-process coverage for `scripts/sync/turbo.ts` — the codegen that derives the
// per-tool turbo tasks in `turbo.json` from the QA tool registry.
//
// WHY these tests matter: turbo.json is generated, not hand-edited. If the
// generator emits the wrong task shape (missing a per-tool `lint:*`, dropping a
// tool's config from `inputs`, or losing the `$schema`), turbo's cache scoping
// breaks — editing a `.md` would bust `lint:oxlint`, the very regression this
// codegen exists to kill. And if `--check` fails to detect drift between the
// committed turbo.json and what the generator would produce, a stale turbo.json
// merges. Each test pins one of those guarantees against the REAL `TOOLS`
// registry (no mock registry — real behaviour).

import { describe, it, expect, afterEach } from "vitest";
import { runScript, resetHarness } from "./harness.ts";

const MODULE = "../../scripts/sync/turbo.ts";

// A stand-in for the `bin/mise exec -- oxfmt` pipe the generator shells out to.
// The real oxfmt just pretty-prints JSON; the test double re-serialises the
// piped-in compact JSON with tab indent + trailing newline, which is a faithful
// stable normalisation for equality purposes (the generator's OWN logic — task
// derivation, ordering, dedupe — runs unmodified; only the formatter binary is
// faked, exactly as a hermetic unit test should).
function oxfmtPass(_cmd?: unknown, _args?: unknown, o?: { input?: string }): unknown {
	return {
		status: 0,
		stdout: `${JSON.stringify(JSON.parse(o?.input ?? "{}"), null, "\t")}\n`,
		stderr: "",
		signal: null,
	};
}

// Simulate oxfmt failing (non-zero exit) so the generator's error path is hit.
function oxfmtFail(): unknown {
	return { status: 1, stdout: "", stderr: "oxfmt: boom", signal: null };
}

// Run the generator in WRITE mode and return the exact turbo.json text it emits.
// Reused as the "matching" fixture for the drift check so the two agree by
// construction (the generator is the source of truth).
async function generate(): Promise<string> {
	const files = new Map<string, string>([["turbo.json", "STALE"]]);
	const res = await runScript(MODULE, { files, argv: [], spawnSync: oxfmtPass });
	expect(res.exitCode).toBeUndefined();
	return files.get("turbo.json") ?? "";
}

// A single turbo task definition as emitted into `tasks`. Fields are optional
// because different task kinds emit different subsets (a lint task has `inputs`,
// an aggregator has `dependsOn`, etc.).
type TaskDef = {
	inputs?: string[];
	outputs?: string[];
	cache?: boolean;
	outputLogs?: string;
	dependsOn?: string[];
};

// Generate the config and return its `tasks` map (the codegen's core output).
async function generateTasks(): Promise<Record<string, TaskDef>> {
	const cfg = JSON.parse(await generate()) as { tasks: Record<string, TaskDef> };
	return cfg.tasks;
}

afterEach(resetHarness);

describe("sync/turbo", () => {
	it("write mode emits a turbo.json with the vendored $schema and global config", async () => {
		// WHY: turbo.json must reference the vendored `./.schemas/turbo.json` so it
		// validates offline, and keep the global deps/env that are NOT per-tool.
		const text = await generate();
		const cfg = JSON.parse(text) as Record<string, unknown>;
		expect(cfg["$schema"]).toBe("./.schemas/turbo.json");
		expect(cfg["globalDependencies"]).toEqual(["mise.lock", "mise.toml"]);
		expect(cfg["globalPassThroughEnv"]).toEqual(["NODE_ENV", "CI"]);
		expect(cfg["ui"]).toBe("tui");
		expect(cfg["dangerouslyDisablePackageManagerCheck"]).toBe(false);
	});

	it("emits the static test + coverage + hygiene tasks with their exact cache/output shape", async () => {
		// WHY: `test:coverage:run` MUST declare `coverage/**` as an output or turbo
		// caches a run that produced no report; `test` must not. These static tasks
		// are what CI keys on.
		const tasks = await generateTasks();
		expect(tasks["test"]).toEqual({ inputs: ["$TURBO_DEFAULT$"], outputs: [] });
		expect(tasks["test:coverage:run"]).toEqual({
			inputs: ["$TURBO_DEFAULT$"],
			outputs: ["coverage/**"],
			outputLogs: "new-only",
		});
		expect(tasks["qa:hooks"]).toEqual({ inputs: ["lefthook.yml"], outputs: [], cache: false });
		expect(tasks["lint:hygiene"]).toEqual({
			inputs: ["$TURBO_DEFAULT$"],
			outputs: [],
			outputLogs: "new-only",
		});
	});

	it("derives one lint:<tool> task per linting tool, scoped to that tool's globs + config", async () => {
		// WHY (the whole point of the codegen): each tool's task inputs must be JUST
		// the files that tool reads, so editing an unrelated file is a cache hit. If
		// `lint:oxlint` didn't carry `.oxlintrc.json`, editing the oxlint config
		// wouldn't re-run oxlint — a correctness hole.
		const tasks = await generateTasks();
		// ext-match tool → per-extension globs, sorted, plus its config file.
		expect(tasks["lint:oxlint"]?.["inputs"]).toContain("**/*.ts");
		expect(tasks["lint:oxlint"]?.["inputs"]).toContain(".oxlintrc.json");
		expect(tasks["lint:typescript"]?.["inputs"]).toContain("tsconfig.json");
		// regex tool check-jsonschema → the special `**/*.schema.json` glob.
		expect(tasks["lint:check-jsonschema"]?.["inputs"]).toEqual(["**/*.schema.json"]);
		// whole-repo tools keep the `$TURBO_DEFAULT$` sentinel FIRST, then config.
		expect(tasks["lint:gitleaks"]?.["inputs"]?.[0]).toBe("$TURBO_DEFAULT$");
		expect(tasks["lint:gitleaks"]?.["inputs"]).toContain(".gitleaks.toml");
		expect(tasks["lint:reuse"]?.["inputs"]).toEqual(["$TURBO_DEFAULT$", "REUSE.toml"]);
	});

	it("derives write + check format tasks for formatting tools (write is never cached)", async () => {
		// WHY: a format WRITE task mutates files, so it must set `cache:false` or
		// turbo could skip a needed rewrite; the check variant is cacheable.
		const tasks = await generateTasks();
		expect(tasks["format:oxfmt"]?.["cache"]).toBe(false);
		expect(tasks["format:check:oxfmt"]?.["outputLogs"]).toBe("new-only");
		expect(tasks["format:taplo"]?.["cache"]).toBe(false);
		expect(tasks["format:check:taplo"]).toBeDefined();
	});

	it("wires the umbrella aggregators to fan out over every per-tool task via dependsOn", async () => {
		// WHY: `pnpm qa:lint` runs the `:all` aggregator; if a per-tool task is not in
		// its dependsOn, that tool silently stops running in CI.
		const tasks = await generateTasks();
		const lintAll = tasks["qa:lint:all"] as { dependsOn: string[]; cache: boolean };
		expect(lintAll.cache).toBe(false);
		expect(lintAll.dependsOn).toContain("lint:hygiene");
		expect(lintAll.dependsOn).toContain("lint:oxlint");
		expect(lintAll.dependsOn).toContain("lint:typescript");
		const fmtAll = tasks["qa:format:all"] as { dependsOn: string[] };
		expect(fmtAll.dependsOn).toContain("format:oxfmt");
		const fmtCheckAll = tasks["qa:format:check:all"] as { dependsOn: string[] };
		expect(fmtCheckAll.dependsOn).toContain("format:check:oxfmt");
	});

	it("--check passes (exit 0) when turbo.json already matches the generator", async () => {
		// WHY: the drift gate must not false-positive on an in-sync turbo.json, or
		// every push fails and the gate gets disabled.
		const canonical = await generate();
		const files = new Map<string, string>([["turbo.json", canonical]]);
		const res = await runScript(MODULE, { files, argv: ["--check"], spawnSync: oxfmtPass });
		expect(res.exitCode).toBeUndefined();
		expect(res.stdout).toContain("turbo.json is in sync.");
		// --check must not rewrite the file.
		expect(res.writes).toEqual([]);
	});

	it("--check FAILS (exit 1) when the committed turbo.json drifted from the generator", async () => {
		// WHY: a hand-edited or stale turbo.json must be caught — that is the entire
		// reason the generated file is gated in CI.
		const files = new Map<string, string>([["turbo.json", '{\n\t"tasks": {}\n}\n']]);
		const res = await runScript(MODULE, { files, argv: ["--check"], spawnSync: oxfmtPass });
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain("turbo.json is out of sync with scripts/sync/turbo.ts.");
		expect(res.stderr).toContain("Run `pnpm sync:turbo` to regenerate.");
	});

	it("throws when oxfmt fails, so a broken formatter aborts the sync loudly", async () => {
		// WHY: vendoring un-normalised JSON would create a format/sync write-loop; a
		// non-zero oxfmt must abort with its stderr, not silently emit junk.
		const files = new Map<string, string>([["turbo.json", "x"]]);
		let thrown: unknown;
		try {
			await runScript(MODULE, { files, argv: [], spawnSync: oxfmtFail });
		} catch (error) {
			thrown = error;
		}
		expect(String(thrown)).toContain("oxfmt failed");
		expect(String(thrown)).toContain("boom");
	});
});
