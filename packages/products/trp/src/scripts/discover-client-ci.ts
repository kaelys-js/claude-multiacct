#!/usr/bin/env node
/**
 * `discover-client-ci.ts` — TS port of `trp/scripts/discover-client-ci.py`.
 *
 * SRP-M / TRP-M: comprehensive client-CI discovery. Discovers verification
 * commands the client's project runs, NOT just what's declared in
 * `.github/workflows`. Sources checked, in order:
 *
 *   1. `.github/workflows/*.yml` — GitHub Actions `run:` steps
 *   2. `package.json` scripts — lint/format/typecheck/test/build (missed by
 *      workflow-only discovery when scripts run in pre-commit hooks instead)
 *   3. `.husky/pre-commit` + `.husky/pre-push` — actual hook scripts (catches
 *      lint-staged errors that used to only surface at `git commit` time)
 *   4. `.pre-commit-config.yaml` — Python-style pre-commit
 *   5. `Makefile` — lint/test/check targets
 *
 * Output: one command per line to `$OUT_PATH`, in discovery order; plus a
 * classified TSV to `discovery/<TASK_ID_SLUG>-ci-commands.tsv` (SRP-LL).
 *
 * Migrated line-for-line from `trp/scripts/discover-client-ci.py` — every
 * regex, print string, output ordering, and side effect is preserved verbatim.
 *
 * @module
 */

import {
	accessSync,
	constants as fsConstants,
	existsSync,
	globSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// SRP-BB: detect package manager / project ecosystem from fingerprints.
function detectPm(root: string): string | null {
	if (isFile(join(root, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (isFile(join(root, "yarn.lock"))) {
		return "yarn";
	}
	if (isFile(join(root, "bun.lockb"))) {
		return "bun";
	}
	if (isFile(join(root, "package-lock.json"))) {
		return "npm";
	}
	if (isFile(join(root, "package.json"))) {
		return "npm";
	}
	return null;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isReadable(path: string): boolean {
	try {
		accessSync(path, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function readTextSafely(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

// Mirror of Python's `{value!r}` formatter for a string body — used to keep
// the wrapper-log line byte-identical to the .py output ("... -> 'body' ...").
// Python prefers single quotes and only switches to double quotes when the
// string contains a single quote (and no double quote). Escapes: \\ then \'.
function pyRepr(value: string): string {
	const hasSingle = value.includes("'");
	const hasDouble = value.includes('"');
	const quote = hasSingle && !hasDouble ? '"' : "'";
	let body = value.replaceAll("\\", String.raw`\\`);
	if (quote === "'") {
		body = body.replaceAll("'", String.raw`\'`);
	} else {
		body = body.replaceAll('"', String.raw`\"`);
	}
	return `${quote}${body}${quote}`;
}

// Python's `json.loads(..., strict=False)` accepts control chars inside
// strings that stock JSON.parse rejects. Best-effort mirror: try strict
// first, then a fallback that strips raw control chars from string bodies.
function parseJsonLenient(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// eslint-disable-next-line no-control-regex
		const relaxed = text.replaceAll(/[\u0000-\u001F]/gu, " ");
		return JSON.parse(relaxed);
	}
}

export type DiscoverConfig = {
	readonly fixSrc: string;
	readonly outPath: string;
	readonly taskIdSlug: string;
};

export type DiscoverResult = {
	readonly commands: readonly string[];
	readonly sources: readonly string[];
	readonly classes: readonly string[];
	readonly tsvPath: string;
};

export async function main(config?: Partial<DiscoverConfig>): Promise<DiscoverResult> {
	await Promise.resolve();
	const fixSrc = config?.fixSrc ?? process.env.FIX_SRC;
	const outPath = config?.outPath ?? process.env.OUT_PATH;
	if (!fixSrc) {
		throw new Error("FIX_SRC not set");
	}
	if (!outPath) {
		throw new Error("OUT_PATH not set");
	}

	const PM = detectPm(fixSrc);
	const IS_PYTHON = ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"].some((f) =>
		isFile(join(fixSrc, f)),
	);
	const IS_GO = isFile(join(fixSrc, "go.mod"));
	const IS_RUST = isFile(join(fixSrc, "Cargo.toml"));

	const QUALITY =
		/\b(lint|format|prettier|test|build|type[- ]?check|check|vitest|eslint|tsc|husky|precommit|pre-commit|validate|clippy|ruff|mypy|flake8|vet|pytest|pyright)\b/iu;
	const SKIP = /\b(deploy|release|publish|notes|e2e|playwright)\b/iu;
	// Skip commands that MUTATE files (fix modes, format without :check). Stage
	// F is a verifier — never modifies fix-src.
	const MUTATE = /(:fix\b|--fix\b|--write\b|^pnpm run format$|^npm run format$|^yarn format$)/iu;

	// SRP-LL: classify each discovered command as cheap (lint / typecheck / fmt-
	// check / validate) or expensive (test / build). The workflow's Preflight
	// phase uses the cheap set for its scratch-worktree runs; the driver uses
	// the same split to parallelize Stage F's cheap group.
	const CHEAP =
		/\b(lint|prettier|tsc|type[- ]?check|typecheck|fmt-check|fmt\s+-check|validate|clippy|ruff|mypy|black\s+--check|flake8|pyright)\b/iu;

	const seen: string[] = [];
	const sourcesUsed: string[] = [];
	const classes: string[] = [];

	function classify(cmd: string): string {
		return CHEAP.test(cmd) ? "cheap" : "expensive";
	}

	function add(cmdIn: string, source: string): boolean {
		let cmd = cmdIn.trim();
		if (cmd.startsWith('"') && cmd.endsWith('"')) {
			cmd = cmd.slice(1, -1);
		} else if (cmd.startsWith('"')) {
			cmd = cmd.slice(1);
		} else if (cmd.endsWith('"')) {
			cmd = cmd.slice(0, -1);
		}
		if (cmd.startsWith("'") && cmd.endsWith("'")) {
			cmd = cmd.slice(1, -1);
		} else if (cmd.startsWith("'")) {
			cmd = cmd.slice(1);
		} else if (cmd.endsWith("'")) {
			cmd = cmd.slice(0, -1);
		}
		if (!cmd || seen.includes(cmd)) {
			return false;
		}
		if (cmd.startsWith("|") || cmd.startsWith(">-") || cmd.startsWith("- ")) {
			return false;
		}
		if (SKIP.test(cmd)) {
			return false;
		}
		if (MUTATE.test(cmd)) {
			return false;
		}
		if (!QUALITY.test(cmd)) {
			return false;
		}
		seen.push(cmd);
		sourcesUsed.push(source);
		classes.push(classify(cmd));
		return true;
	}

	// ── 1. GitHub Actions workflows ────────────────────────────────────
	const wfDir = join(fixSrc, ".github", "workflows");
	if (isDir(wfDir)) {
		const wfs = globSync(join(wfDir, "*.y*ml")).toSorted();
		for (const wf of wfs) {
			const base = basename(wf);
			const body = readTextSafely(wf);
			if (body !== null) {
				for (const line of body.split("\n")) {
					const m = /^\s*run:\s*(.+?)\s*$/u.exec(line);
					if (m) {
						add(m[1] ?? "", `workflow:${base}`);
					}
				}
			}
		}
	}

	// ── 2. package.json scripts (catches lint-only-in-pre-commit) ──────
	// Multi-app monorepos (e.g. Handled) may have no root package.json but
	// per-app scripts under apps/<name>/package.json. Discover ALL of them and
	// use pnpm --filter to run each.
	// Phase-1 SRP-33: wrapper detection. A root-level script whose body just delegates
	// to nx / turbo / a docker compose harness / a tsx script isn't a verifier itself
	// — running `pnpm run lint` on it re-enters the same delegator we already emit
	// directly (or worse, tries to spawn docker inside Stage F). Detect these so we
	// can route around them (nx-affected, per-workspace filter, or skip) instead of
	// emitting a wrapper that will fail or duplicate work.
	const WRAPPER_PATTERNS: readonly RegExp[] = [
		/^\s*(pnpm\s+)?nx\s+(run-many|affected|run|exec)\b/iu,
		/^\s*(pnpm\s+)?turbo\s+(run|--filter)\b/iu,
		/^\s*docker(\s+compose|-compose)?\b/iu,
		/^\s*tsx\s+/iu,
		/^\s*pnpm\s+run\s+docker:/iu,
	];

	function isWrapper(body: string | undefined | null): boolean {
		if (!body) {
			return false;
		}
		// Handle && / ; chained scripts where the first non-empty segment is the wrapper.
		const first = (body.split(/&&|;|\|\|/u, 1)[0] ?? "").trim();
		return WRAPPER_PATTERNS.some((p) => p.test(first));
	}

	function scanPackageJson(pjPath: string, workspaceHint: string | null = null): void {
		let d: Record<string, unknown>;
		try {
			const body = readFileSync(pjPath, "utf8");
			const parsed = parseJsonLenient(body);
			if (!parsed || typeof parsed !== "object") {
				process.stdout.write(`   WARN: failed to parse ${pjPath}: not an object\n`);
				return;
			}
			d = parsed as Record<string, unknown>;
		} catch (error) {
			process.stdout.write(`   WARN: failed to parse ${pjPath}: ${String(error)}\n`);
			return;
		}
		const rawScripts = d.scripts;
		const scripts: Record<string, string> =
			rawScripts && typeof rawScripts === "object" ? (rawScripts as Record<string, string>) : {};
		const pmRunMap: Record<string, string> = {
			pnpm: "pnpm run",
			yarn: "yarn",
			bun: "bun run",
			npm: "npm run",
		};
		const pmRun = (PM && pmRunMap[PM]) ?? "pnpm run";
		const preferredOrder = [
			"lint",
			"lint:check",
			"typecheck",
			"type-check",
			"tsc:check",
			"test",
			"test:unit",
			"test:ci",
			"test:e2e:ci",
			"test:projects",
		];
		for (const name of preferredOrder) {
			if (name in scripts) {
				const body = scripts[name] ?? "";
				// Phase-1: root-level wrapper scripts get routed through per-workspace
				// filter (fallback #3) instead of emitting the wrapper directly. Rule 5:
				// non-wrapper root scripts are preserved — real work at the root still
				// runs at the root.
				if (workspaceHint === null && isWrapper(body)) {
					process.stdout.write(
						`   wrapper: root scripts.${name} -> ${pyRepr(body)} — deferring to per-workspace / nx fallback\n`,
					);
				} else {
					let cmd: string;
					let source: string;
					if (workspaceHint && PM === "pnpm") {
						// Run against the specific workspace so per-app scripts fire.
						cmd = `pnpm --filter ${workspaceHint} run ${name}`;
						source = `${workspaceHint}/package.json:scripts.${name}`;
					} else {
						cmd = `${pmRun} ${name}`;
						source = `package.json:scripts.${name}`;
					}
					add(cmd, source);
				}
			}
		}
	}

	const pj = join(fixSrc, "package.json");
	if (isFile(pj)) {
		scanPackageJson(pj);
	}
	// Multi-app: iterate apps/*/package.json + packages/*/package.json.
	for (const globPat of [
		"apps/*/package.json",
		"packages/*/package.json",
		"libs/*/package.json",
		"services/*/package.json",
	]) {
		const extras = globSync(join(fixSrc, globPat)).toSorted();
		for (const extraPj of extras) {
			const appDir = basename(dirname(extraPj));
			// Read the app's package.json name field for the --filter target.
			let name: string = appDir;
			try {
				const body = readFileSync(extraPj, "utf8");
				const parsed = parseJsonLenient(body);
				if (parsed && typeof parsed === "object") {
					const nField = (parsed as Record<string, unknown>).name;
					if (typeof nField === "string" && nField) {
						name = nField;
					}
				}
			} catch {
				// keep appDir fallback
			}
			scanPackageJson(extraPj, name);
		}
	}
	// (Multi-app package.json discovery handled above via scanPackageJson().)

	// ── 3. husky pre-commit / pre-push hooks ──────────────────────────
	// Most husky hooks use lint-staged which only lints STAGED files — running
	// the hook script standalone with no staged files is a no-op. We already
	// catch the underlying lint via `pnpm run lint` from package.json. Only add
	// husky hooks that don't invoke lint-staged (heuristic: read the hook body).
	for (const hookName of ["pre-commit", "pre-push"]) {
		const hookPath = join(fixSrc, ".husky", hookName);
		if (isFile(hookPath) && isReadable(hookPath)) {
			try {
				const body = readFileSync(hookPath, "utf8");
				if (!body.includes("lint-staged")) {
					// Custom hook — run it as-is.
					add(`sh .husky/${hookName}`, `.husky/${hookName}`);
				} // else: covered by `pnpm run lint` above
			} catch {
				// swallow
			}
		}
	}

	// ── 4. .pre-commit-config.yaml (Python-flavored) ──────────────────
	if (isFile(join(fixSrc, ".pre-commit-config.yaml"))) {
		add("pre-commit run --all-files", ".pre-commit-config.yaml");
	}

	// ── 4b. Python / Go / Rust project files ──────────────────────────
	if (IS_PYTHON) {
		// Only add tools the project actually declares. `pytest` unconditional was
		// a pre-May-2026 bug: a project using `unittest` would break Stage F on
		// "pytest not found", triggering an expensive REVISE loop that couldn't
		// succeed. Read pyproject.toml + requirements + setup.cfg for real signals.
		let pySignals = "";
		for (const name of [
			"pyproject.toml",
			"setup.cfg",
			"requirements.txt",
			"requirements-dev.txt",
			"Pipfile",
			"tox.ini",
		]) {
			const p = join(fixSrc, name);
			if (isFile(p)) {
				try {
					pySignals += `\n${readFileSync(p, "utf8")}`;
				} catch {
					// swallow
				}
			}
		}
		const pyTools: ReadonlyArray<[string, RegExp]> = [
			["pytest", /\bpytest\b/iu],
			["ruff check .", /\bruff\b/iu],
			["mypy .", /\bmypy\b/iu],
			["black --check .", /\bblack\b/iu],
			["flake8", /\bflake8\b/iu],
		];
		for (const [cmd, needle] of pyTools) {
			if (needle.test(pySignals)) {
				add(cmd, "python-project");
			}
		}
	}
	if (IS_GO) {
		for (const tool of ["go vet ./...", "go test ./...", "go build ./..."]) {
			add(tool, "go-project");
		}
	}
	if (IS_RUST) {
		for (const tool of ["cargo clippy -- -D warnings", "cargo test", "cargo build"]) {
			add(tool, "rust-project");
		}
	}

	// Terraform: any infra fix that touches .tf files. Discover
	// terraform fmt + validate when present.
	const tfHits = globSync("**/*.tf", { cwd: fixSrc });
	if (tfHits.length > 0) {
		for (const tool of ["terraform fmt -check -recursive", "terraform validate"]) {
			add(tool, "terraform-project");
		}
	}

	// nx monorepo: `nx.json` present + root package.json depends on nx.
	// Handled uses nx affected --target=lint over apps/. Emit both lint + test
	// via nx so apps/*/package.json without their own scripts still run.
	if (isFile(join(fixSrc, "nx.json"))) {
		// Phase-1 SRP-33: prefer `nx affected` (smaller blast radius, faster) over
		// `run-many --all`. `affected` needs a base ref; the driver clones the
		// client at a pinned SHA into a fresh worktree, so HEAD~1 approximates
		// "changes in this fix". Emit both — run-many is the safety net when the
		// base ref isn't available or nx can't compute affected.
		for (const tool of [
			"pnpm nx affected --target=lint --base=HEAD~1",
			"pnpm nx affected --target=test --base=HEAD~1",
			"pnpm nx run-many --target=lint --all",
			"pnpm nx run-many --target=test --all",
		]) {
			add(tool, "nx-project");
		}
	}

	// ── 5. Makefile common targets ────────────────────────────────────
	const mf = join(fixSrc, "Makefile");
	if (isFile(mf)) {
		const body = readTextSafely(mf);
		if (body !== null) {
			for (const line of body.split("\n")) {
				const m = /^(lint|test|check|typecheck|format)(?::)?\s*:/u.exec(line);
				if (m) {
					const target = m[1] ?? "";
					add(`make ${target}`, `Makefile:${target}`);
				}
			}
		}
	}

	// ── output ─────────────────────────────────────────────────────────
	if (seen.length === 0) {
		process.stdout.write("   no CI verify commands discovered — nothing to run\n");
	} else {
		const nCheap = classes.filter((c) => c === "cheap").length;
		const nExp = classes.length - nCheap;
		const nSources = new Set(sourcesUsed).size;
		process.stdout.write(
			`   discovered ${seen.length} CI verify command(s) from ${nSources} sources (${nCheap} cheap, ${nExp} expensive):\n`,
		);
		for (let i = 0; i < seen.length; i++) {
			process.stdout.write(`     - [${classes[i]}] ${seen[i]}  [${sourcesUsed[i]}]\n`);
		}
	}
	writeFileSync(outPath, `${seen.join("\n")}\n`);

	// SRP-LL: TSV output with class column so the workflow's Preflight phase and
	// the driver's Stage F can split cheap vs expensive. Written to a per-SEC
	// path when TASK_ID_SLUG is set; otherwise a 'default' key. The legacy $OUT_PATH
	// file (one command per line, no class) is unchanged for back-compat.
	const taskIdSlug = (config?.taskIdSlug ?? process.env.TASK_ID_SLUG ?? "default").toLowerCase();
	if (!existsSync("discovery")) {
		mkdirSync("discovery", { recursive: true });
	}
	const tsvPath = `discovery/${taskIdSlug}-ci-commands.tsv`;
	let tsvBody = "command\tsource\tclass\n";
	for (let i = 0; i < seen.length; i++) {
		tsvBody += `${seen[i]}\t${sourcesUsed[i]}\t${classes[i]}\n`;
	}
	writeFileSync(tsvPath, tsvBody);
	process.stdout.write(`   wrote classified TSV -> ${tsvPath}\n`);

	return {
		commands: seen,
		sources: sourcesUsed,
		classes,
		tsvPath,
	};
}

// Only run main() when this file is invoked directly (not on test import).
function isDirectRun(): boolean {
	const [, entry] = process.argv;
	if (!entry) {
		return false;
	}
	try {
		return realpathSync(import.meta.filename) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		await main();
		process.exit(0);
	} catch (error: unknown) {
		process.stderr.write(`discover-client-ci: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
