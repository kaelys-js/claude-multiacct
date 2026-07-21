#!/usr/bin/env node
/**
 * Sync derived version files from the single source of truth in `mise.toml`.
 *
 * mise owns the node and pnpm versions (`[tools]` table). This script mirrors
 * them into the files other tooling reads:
 *   - `.nvmrc`               — node version (nvm / editors / mise idiomatic file)
 *   - `package.json` engines — `node`, `pnpm`
 *   - `package.json` packageManager — `pnpm@<ver>`
 *
 * `--check` exits non-zero when any derived file is out of sync (CI drift).
 *
 * @module
 */

import { repoRoot } from "@foundation/core";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readToolVersion } from "./mise-toml.ts";

const ROOT = repoRoot();
const MISE_TOML = join(ROOT, "mise.toml");
const NVMRC = join(ROOT, ".nvmrc");
const PACKAGE_JSON = join(ROOT, "package.json");

// Assert engines live ONLY at the root package.json (the workspace anchor, per
// STEP-0.1). A sub-package that declares its own `engines` would fragment the
// pinned node/pnpm across the monorepo, so `--check` fails on it — the multi-
// package reality can't drift silently. Discovers package.json files via
// `git ls-files` (the same plumbing schema-check/gitmeta use).
function checkWorkspaceEngines(): string[] {
	const listed = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
	const subPackages = listed.stdout
		.split("\n")
		.filter(
			(rel) =>
				rel !== "package.json" && rel.endsWith("/package.json") && !rel.includes("node_modules"),
		);
	const problems: string[] = [];
	for (const rel of subPackages) {
		const pkg = JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as {
			engines?: Record<string, string>;
		};
		if (pkg.engines !== undefined) {
			problems.push(
				`${rel}: a sub-package must NOT declare its own \`engines\` — node/pnpm are pinned once at the root package.json (the workspace anchor). Remove the field.`,
			);
		}
	}
	return problems;
}

/** The derived files this script keeps in sync, as name→(current, desired) text. */
type Derived = { readonly label: string; readonly current: string; readonly desired: string };

// Compute the desired content of every derived file from the mise versions.
function computeDerived(): Derived[] {
	const toml = readFileSync(MISE_TOML, "utf8");
	const node = readToolVersion(toml, "node");
	const pnpm = readToolVersion(toml, "pnpm");

	const nvmrcCurrent = readFileSync(NVMRC, "utf8");
	const packageCurrent = readFileSync(PACKAGE_JSON, "utf8");
	const pkg = JSON.parse(packageCurrent) as {
		engines?: Record<string, string>;
		packageManager?: string;
	};
	pkg.engines = { ...pkg.engines, node, pnpm };
	pkg.packageManager = `pnpm@${pnpm}`;

	return [
		{ label: ".nvmrc", current: nvmrcCurrent, desired: `${node}\n` },
		{
			label: "package.json",
			current: packageCurrent,
			desired: `${JSON.stringify(pkg, null, "\t")}\n`,
		},
	];
}

const derived = computeDerived();
const check = process.argv.includes("--check");
const drifted = derived.filter((d) => d.current !== d.desired);
const engineProblems = checkWorkspaceEngines();

if (check) {
	if (drifted.length > 0 || engineProblems.length > 0) {
		for (const d of drifted) {
			process.stderr.write(`${d.label} is out of sync with mise.toml.\n`);
		}
		for (const problem of engineProblems) {
			process.stderr.write(`${problem}\n`);
		}
		process.stderr.write(
			"Run `pnpm sync:versions` to fix version drift (engine problems are manual).\n",
		);
		process.exit(1);
	}
	process.stdout.write("Versions are in sync.\n");
} else {
	const targets: Readonly<Record<string, string>> = {
		".nvmrc": NVMRC,
		"package.json": PACKAGE_JSON,
	};
	for (const d of drifted) {
		writeFileSync(targets[d.label] ?? "", d.desired);
		process.stdout.write(`Wrote ${d.label}.\n`);
	}
	if (drifted.length === 0) {
		process.stdout.write("Versions already in sync.\n");
	}
	// Engine problems can't be auto-fixed (removing a stray field is a human
	// decision), so surface them and fail even in write mode.
	if (engineProblems.length > 0) {
		for (const problem of engineProblems) {
			process.stderr.write(`${problem}\n`);
		}
		process.exit(1);
	}
}
