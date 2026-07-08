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

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Match, type Tool, TOOLS } from "../qa/registry.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TURBO_JSON = join(ROOT, "turbo.json");
const MISE = join(ROOT, "bin/mise");

/**
 * Root-relative config file(s) a tool reads, added to that tool's task inputs so
 * that editing a tool's config busts only that tool's cache.
 */
const CONFIG_FILES: Readonly<Record<string, readonly string[]>> = {
	oxlint: [".oxlintrc.json"],
	oxfmt: [".oxfmtrc.json", ".editorconfig"],
	yamllint: [".yamllint"],
	taplo: ["taplo.toml"],
	markdownlint: [".markdownlint-cli2.jsonc"],
	"check-jsonschema": [],
	gitleaks: [".gitleaks.toml"],
	typescript: ["tsconfig.json"],
	reuse: ["REUSE.toml"],
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

// Generate the full `tasks` map: the static hand-maintained tasks plus the
// per-tool lint/format tasks and their umbrella aggregators, in a deterministic
// order (tools in registry order; static tasks first).
//
// foundation-registry is a SINGLE-PACKAGE repo, so turbo tasks use bare names
// (not the `//#<task>` package-task syntax stardust's monorepo uses — turbo
// rejects `//#` in single-package mode). Each task name matches a package.json
// script; the `qa:*:all` aggregators fan out to the per-tool tasks via
// `dependsOn`.
function generateTasks(): Record<string, TaskDef> {
	const tasks: Record<string, TaskDef> = {
		"qa:hooks": { inputs: ["lefthook.yml"], outputs: [], cache: false },
		// Hygiene guard (merge-conflict markers, oversized files) — whole-repo scope.
		"lint:hygiene": {
			inputs: ["$TURBO_DEFAULT$"],
			outputs: [],
			outputLogs: "new-only",
		},
	};

	const lintDeps: string[] = ["lint:hygiene"];
	const formatDeps: string[] = [];
	const formatCheckDeps: string[] = [];

	for (const tool of TOOLS) {
		const inputs = taskInputs(tool);
		if (tool.lint) {
			const key = `lint:${tool.id}`;
			tasks[key] = { inputs, outputs: [], outputLogs: "new-only" };
			lintDeps.push(key);
		}
		if (tool.format) {
			const writeKey = `format:${tool.id}`;
			// Write mutates files in place — never cache it.
			tasks[writeKey] = { inputs, outputs: [], cache: false };
			formatDeps.push(writeKey);
			const checkKey = `format:check:${tool.id}`;
			tasks[checkKey] = { inputs, outputs: [], outputLogs: "new-only" };
			formatCheckDeps.push(checkKey);
		}
	}

	// Umbrella aggregators: `pnpm qa:lint` runs `turbo run qa:lint:all`, whose
	// script is a trivial no-op that depends on every per-tool lint task. The
	// aggregator is named `:all` (distinct from the `qa:lint` driver script) so
	// turbo does not see the driver re-invoking its own task (recursion).
	tasks["qa:lint:all"] = { dependsOn: lintDeps, outputs: [], cache: false };
	tasks["qa:format:all"] = { dependsOn: formatDeps, outputs: [], cache: false };
	tasks["qa:format:check:all"] = { dependsOn: formatCheckDeps, outputs: [], cache: false };

	return tasks;
}

// The full generated `turbo.json` object.
function generateConfig(): Record<string, unknown> {
	return {
		$schema: "https://turbo.build/schema.json",
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
	const compact = JSON.stringify(generateConfig());
	const res = spawnSync(MISE, ["exec", "--", "oxfmt", "--stdin-filepath", TURBO_JSON], {
		input: compact,
		encoding: "utf8",
	});
	if (res.status !== 0) {
		throw new Error(`oxfmt failed: ${res.stderr}`);
	}
	return res.stdout;
}

const generated = render();

if (process.argv.includes("--check")) {
	const current = readFileSync(TURBO_JSON, "utf8");
	if (current !== generated) {
		process.stderr.write("turbo.json is out of sync with scripts/sync/turbo.ts.\n");
		process.stderr.write("Run `pnpm sync:turbo` to regenerate.\n");
		process.exit(1);
	}
	process.stdout.write("turbo.json is in sync.\n");
} else {
	writeFileSync(TURBO_JSON, generated);
	process.stdout.write("Wrote turbo.json.\n");
}
