#!/usr/bin/env node
/**
 * Codegen for the per-tool turbo tasks in `turbo.json`.
 *
 * The QA runner used to be one `qa:lint` / `qa:format` turbo task with
 * whole-repo inputs, so touching any file busted the whole cache. This script
 * derives ONE turbo task PER TOOL from the {@link TOOLS} registry, each scoped
 * to only the file globs (and config files) that tool actually reads — so
 * editing a `.md` re-runs `//#lint:markdownlint` while `//#lint:oxlint` stays a
 * cache hit.
 *
 * The generated `tasks` object is deterministic (tools in registry order, keys
 * sorted). `--check` exits non-zero when `turbo.json` is out of sync with what
 * this script would generate (CI drift detection).
 *
 * @module
 */

import { repoRoot } from "@foundation/core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Match, type Tool, TOOLS } from "@foundation/qa/registry";
import { oxfmtText } from "./oxfmt.ts";

const ROOT = repoRoot();
const TURBO_JSON = join(ROOT, "turbo.json");

/**
 * Root-relative config file(s) a tool reads, added to that tool's task inputs so
 * that editing a tool's config busts only that tool's cache.
 */
// Config paths reflect the Stage-0 relocation into @foundation/config: every QA
// tool config now lives under packages/shared/config/ and is reached by `--config`
// (oxlint per oxc#20087, oxfmt, taplo, syncpack, ec, gitleaks, yamllint,
// markdownlint) — so only the moved file(s) bust that tool's cache; no root config
// stubs remain for the QA tools (lefthook's stub is handled by the qa:hooks task).
const CONFIG_FILES: Readonly<Record<string, readonly string[]>> = {
	oxlint: ["packages/shared/config/oxlint.json"],
	oxfmt: ["packages/shared/config/oxfmt.json", ".editorconfig"],
	yamllint: ["packages/shared/config/yamllint-base.yaml"],
	taplo: ["packages/shared/config/taplo.toml"],
	markdownlint: [
		"packages/shared/config/.markdownlint-cli2.jsonc",
		"packages/shared/config/markdownlint.jsonc",
	],
	"check-jsonschema": [],
	gitleaks: ["packages/shared/config/gitleaks.toml"],
	typescript: ["tsconfig.json", "packages/shared/config/tsconfig.base.json"],
	reuse: ["REUSE.toml"],
	editorconfig: [
		".editorconfig",
		"packages/shared/config/editorconfig-checker.json",
		"packages/shared/utils/qa/src/editorconfig-check.ts",
	],
	gitmeta: [
		".gitattributes",
		".gitignore",
		".npmrc",
		"packages/shared/utils/qa/src/gitmeta-check.ts",
	],
	lefthook: [
		"lefthook.yml",
		"packages/shared/config/lefthook.yml",
		"packages/shared/utils/qa/src/lefthook-check.ts",
	],
	syncpack: ["packages/shared/config/syncpack.json"],
};

// File globs implied by a tool's {@link Match}, i.e. the set of files that tool
// runs over. These become the turbo task's `inputs`, so the task is a cache hit
// unless one of these files (or the tool's config) changed.
function matchGlobs(match: Match, id: string): string[] {
	switch (match.kind) {
		case "ext": {
			return match.extensions.map((ext) => `**/*.${ext}`);
		}
		case "regex": {
			// The only regex tool is check-jsonschema over `*.schema.json`.
			return id === "check-jsonschema" ? ["**/*.schema.json"] : ["$TURBO_DEFAULT$"];
		}
		case "secrets": {
			return ["$TURBO_DEFAULT$"];
		}
	}
}

// The turbo `inputs` array for a tool: its file globs plus its config file(s),
// de-duplicated and sorted for deterministic output. Whole-repo tools keep the
// `$TURBO_DEFAULT$` sentinel first (it is order-significant, not a glob).
function taskInputs(tool: Tool): string[] {
	const globs = matchGlobs(tool.match, tool.id);
	const config = CONFIG_FILES[tool.id] ?? [];
	const wholeRepo = globs.includes("$TURBO_DEFAULT$");
	const rest = [
		...new Set([...globs.filter((g) => g !== "$TURBO_DEFAULT$"), ...config]),
	].toSorted();
	return wholeRepo ? ["$TURBO_DEFAULT$", ...rest] : rest;
}

/** A single turbo task definition (the shape we emit into `tasks`). */
type TaskDef = {
	inputs?: string[];
	outputs?: string[];
	cache?: boolean;
	outputLogs?: string;
	dependsOn?: string[];
};

// The `//#` prefix marks a task that runs in the WORKSPACE ROOT package. foundation
// is a multi-package pnpm workspace (`packages/**`), so a BARE task name runs in the
// member packages, not root — turbo's package-task resolution. The QA per-tool
// lint/format tasks are WHOLE-REPO operations (the dispatch in @foundation/qa scans
// every tracked file), and only a ROOT task can carry whole-repo `inputs` for
// cache-scoping — a member-package task's inputs are package-relative and could not
// express `**/*.ts` across the repo. So the tooling CODE lives in @foundation/qa
// while these tasks stay `//#` root tasks whose scripts live in the root
// package.json. The vitest run is likewise one root-level pass over every package
// (single coverage config), so `test`/`test:coverage:run` are root tasks. Each `//#`
// task name matches a root `package.json` script; the `qa:*:all` aggregators fan out
// to the per-tool tasks via `dependsOn`.
const ROOT_TASK = "//#";

// Generate the full `tasks` map: the static hand-maintained tasks plus the
// per-tool lint/format tasks and their umbrella aggregators, in a deterministic
// order (tools in registry order; static tasks first).
function generateTasks(): Record<string, TaskDef> {
	const tasks: Record<string, TaskDef> = {
		// Per-package `clean` fan-out: `turbo run clean` runs each member package's
		// own `clean` script, so this stays BARE (not `//#`) to target the packages.
		// Never cached (it deletes artefacts). The root `clean`/`clean:all` scripts
		// wrap this + an rm.
		clean: { cache: false, outputs: [] },
		// lefthook config: the root stub (required for hook discovery) + the moved
		// authoritative base it `extends`, both under @foundation/config's ownership.
		"qa:hooks": {
			inputs: ["lefthook.yml", "packages/shared/config/lefthook.yml"],
			outputs: [],
			cache: false,
		},
		// Unit test run (no coverage) — one root-level vitest pass over every
		// package, so it is a root task.
		[`${ROOT_TASK}test`]: { inputs: ["$TURBO_DEFAULT$"], outputs: [] },
		// Coverage run — one root-level vitest pass emitting the `coverage/**` tree.
		[`${ROOT_TASK}test:coverage:run`]: {
			inputs: ["$TURBO_DEFAULT$"],
			outputs: ["coverage/**"],
			outputLogs: "new-only",
		},
		// Hygiene guard (merge-conflict markers, oversized files) — whole-repo scope.
		[`${ROOT_TASK}lint:hygiene`]: {
			inputs: ["$TURBO_DEFAULT$"],
			outputs: [],
			outputLogs: "new-only",
		},
	};

	const lintDeps: string[] = [`${ROOT_TASK}lint:hygiene`];
	const formatDeps: string[] = [];
	const formatCheckDeps: string[] = [];

	for (const tool of TOOLS) {
		const inputs = taskInputs(tool);
		if (tool.lint) {
			const key = `${ROOT_TASK}lint:${tool.id}`;
			tasks[key] = { inputs, outputs: [], outputLogs: "new-only" };
			lintDeps.push(key);
		}
		if (tool.format) {
			const writeKey = `${ROOT_TASK}format:${tool.id}`;
			// Write mutates files in place — never cache it.
			tasks[writeKey] = { inputs, outputs: [], cache: false };
			formatDeps.push(writeKey);
			const checkKey = `${ROOT_TASK}format:check:${tool.id}`;
			tasks[checkKey] = { inputs, outputs: [], outputLogs: "new-only" };
			formatCheckDeps.push(checkKey);
		}
	}

	// Umbrella aggregators: `pnpm qa:lint` runs `turbo run //#qa:lint:all`, whose
	// root script is a trivial no-op that depends on every per-tool root task. The
	// aggregator is named `:all` (distinct from the `qa:lint` driver script) so
	// turbo does not see the driver re-invoking its own task (recursion).
	tasks[`${ROOT_TASK}qa:lint:all`] = { dependsOn: lintDeps, outputs: [], cache: false };
	tasks[`${ROOT_TASK}qa:format:all`] = { dependsOn: formatDeps, outputs: [], cache: false };
	tasks[`${ROOT_TASK}qa:format:check:all`] = {
		dependsOn: formatCheckDeps,
		outputs: [],
		cache: false,
	};

	return tasks;
}

// The full generated `turbo.json` object.
function generateConfig(): Record<string, unknown> {
	return {
		// Vendored locally (offline-safe), like mise/pnpm-workspace reference `./.schemas/`.
		$schema: "./.schemas/turbo.json",
		// Only truly-global inputs remain here. Each tool's config moved into its
		// own task inputs so editing e.g. `.yamllint` busts only yamllint.
		globalDependencies: ["mise.lock", "mise.toml"],
		globalPassThroughEnv: ["NODE_ENV", "CI"],
		ui: "tui",
		dangerouslyDisablePackageManagerCheck: false,
		tasks: generateTasks(),
	};
}

// The serialised form of the generated config, normalised through oxfmt so the
// generated `turbo.json` matches what `qa:format` expects (no sync/format
// write-loop between this generator and the oxfmt formatter).
function render(): string {
	return oxfmtText(JSON.stringify(generateConfig()), TURBO_JSON);
}

const generated = render();

if (process.argv.includes("--check")) {
	const current = readFileSync(TURBO_JSON, "utf8");
	if (current !== generated) {
		process.stderr.write(
			"turbo.json is out of sync with packages/shared/utils/sync/src/turbo.ts.\n",
		);
		process.stderr.write("Run `pnpm sync:turbo` to regenerate.\n");
		process.exit(1);
	}
	process.stdout.write("turbo.json is in sync.\n");
} else {
	writeFileSync(TURBO_JSON, generated);
	process.stdout.write("Wrote turbo.json.\n");
}
