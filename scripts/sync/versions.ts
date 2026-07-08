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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const MISE_TOML = join(ROOT, "mise.toml");
const NVMRC = join(ROOT, ".nvmrc");
const PACKAGE_JSON = join(ROOT, "package.json");

// Read a tool's pinned version from the `[tools]` table of `mise.toml`.
// Only the `[tools]` section is scanned, so an identically-named key elsewhere
// (e.g. under `[env]`) can't be mistaken for a tool pin.
function readToolVersion(toml: string, tool: string): string {
	const lines = toml.split("\n");
	let inTools = false;
	for (const line of lines) {
		const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
		if (header) {
			inTools = header[1] === "tools";
		} else if (inTools) {
			const match = new RegExp(String.raw`^\s*"?${tool}"?\s*=\s*"([^"]+)"`, "u").exec(line);
			if (match?.[1] !== undefined) {
				return match[1];
			}
		}
	}
	throw new Error(`mise.toml: no [tools] entry for "${tool}"`);
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

if (check) {
	if (drifted.length > 0) {
		for (const d of drifted) {
			process.stderr.write(`${d.label} is out of sync with mise.toml.\n`);
		}
		process.stderr.write("Run `pnpm sync:versions` to fix.\n");
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
}
