// In-process coverage for `packages/shared/utils/sync/src/versions.ts` — the mise→derived-files
// mirror (.nvmrc + package.json engines/packageManager).
//
// WHY these tests matter: versions.ts is the single-source-of-truth enforcer.
// If a drift goes unreported (`--check` false-negative) or a write corrupts the
// derived files, the repo's node/pnpm pins silently diverge from mise.toml —
// exactly the split-brain the script exists to prevent. Each test pins a real
// behaviour of that guarantee, not merely "some line ran".

// The oxlint `vitest/no-conditional-in-test` rule flags `??` fallbacks used when
// reading back the in-memory fixture map (e.g. `files.get(...) ?? "{}"`), which
// are defensive defaults, not branching test logic — a false positive here, so
// the rule is disabled file-wide (same as the base validator suite).
/* oxlint-disable vitest/no-conditional-in-test */

import { describe, it, expect, afterEach } from "vitest";
import { runScript, resetHarness, type HarnessResult, type SpawnStub } from "./harness.ts";

const MODULE = "../src/versions.ts";

// A spawnSync stub returning a fixed `git ls-files` listing — the engines guard's
// only child process. Hoisted so it isn't recreated per test.
function gitLsFiles(stdout: string): SpawnStub {
	return () => ({ status: 0, stdout, stderr: "", signal: null });
}

// A mise.toml whose [tools] table pins node + pnpm to KNOWN test values, plus a
// decoy [env] entry named `node` that MUST be ignored (only [tools] is scanned).
function miseToml(node = "22.1.0", pnpm = "10.2.0"): string {
	return [
		"[env]",
		'node = "SHOULD-BE-IGNORED"',
		"[tools]",
		`node = "${node}"`,
		`"pnpm" = "${pnpm}"`,
		'python = "3.13"',
		"",
	].join("\n");
}

// package.json text as the script reads it (JSON with tab indent + trailing NL,
// matching what a `writeFileSync` round-trip produces).
function pkgJson(node: string, pnpm: string): string {
	return `${JSON.stringify(
		{ name: "x", engines: { node, pnpm }, packageManager: `pnpm@${pnpm}` },
		null,
		"\t",
	)}\n`;
}

function inSyncFiles(): Map<string, string> {
	return new Map<string, string>([
		["mise.toml", miseToml("22.1.0", "10.2.0")],
		[".nvmrc", "22.1.0\n"],
		["package.json", pkgJson("22.1.0", "10.2.0")],
	]);
}

afterEach(resetHarness);

describe("sync/versions", () => {
	it("baseline: fully in-sync repo reports no drift in --check (exit 0)", async () => {
		// WHY: the check gate must NOT false-positive on a correct repo, or every
		// push would fail spuriously and the gate would be turned off.
		const res = await runScript(MODULE, { files: inSyncFiles(), argv: ["--check"] });
		expect(res.exitCode).toBeUndefined();
		expect(res.stdout).toContain("Versions are in sync.");
		expect(res.stderr).toBe("");
		expect(res.writes).toEqual([]);
	});

	it("--check FAILS (exit 1) and names every drifted file when derived files lag mise.toml", async () => {
		// WHY: a stale .nvmrc / package.json means the repo's node pin disagrees
		// with mise's — the exact split-brain the gate exists to block. Silent
		// tolerance here defeats the whole script.
		const files = new Map<string, string>([
			["mise.toml", miseToml("22.1.0", "10.2.0")],
			[".nvmrc", "18.0.0\n"],
			["package.json", pkgJson("18.0.0", "9.0.0")],
		]);
		const res = await runScript(MODULE, { files, argv: ["--check"] });
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain(".nvmrc is out of sync with mise.toml.");
		expect(res.stderr).toContain("package.json is out of sync with mise.toml.");
		expect(res.stderr).toContain("Run `pnpm sync:versions` to fix version drift");
		// --check must NEVER write — it only reports.
		expect(res.writes).toEqual([]);
	});

	it("write mode rewrites drifted derived files to match mise.toml, preserving other package.json keys", async () => {
		// WHY: the fix must be surgical — mirror node/pnpm into .nvmrc and the
		// engines/packageManager fields WITHOUT dropping unrelated package.json keys
		// (regression: a naive rewrite would clobber `name`).
		const files = new Map<string, string>([
			["mise.toml", miseToml("22.1.0", "10.2.0")],
			[".nvmrc", "old\n"],
			["package.json", '{\n\t"name": "keep-me",\n\t"private": true\n}\n'],
		]);
		const res = await runScript(MODULE, { files, argv: [] });
		expect(res.exitCode).toBeUndefined();
		expect(files.get(".nvmrc")).toBe("22.1.0\n");
		const pkg = JSON.parse(files.get("package.json") ?? "{}") as {
			name: string;
			private: boolean;
			engines: Record<string, string>;
			packageManager: string;
		};
		expect(pkg.name).toBe("keep-me");
		expect(pkg.private).toBe(true);
		expect(pkg.engines).toEqual({ node: "22.1.0", pnpm: "10.2.0" });
		expect(pkg.packageManager).toBe("pnpm@10.2.0");
		expect(res.stdout).toContain("Wrote .nvmrc.");
		expect(res.stdout).toContain("Wrote package.json.");
	});

	it("write mode adds engines when package.json had none (undefined-engines spread path)", async () => {
		// WHY: a package.json with NO engines block must gain one — the `{...engines}`
		// spread has to tolerate `engines` being undefined, not throw.
		const files = new Map<string, string>([
			["mise.toml", miseToml("22.1.0", "10.2.0")],
			[".nvmrc", "old\n"],
			["package.json", '{\n\t"name": "no-engines"\n}\n'],
		]);
		await runScript(MODULE, { files, argv: [] });
		const pkg = JSON.parse(files.get("package.json") ?? "{}") as {
			engines: Record<string, string>;
		};
		expect(pkg.engines).toEqual({ node: "22.1.0", pnpm: "10.2.0" });
	});

	it("write mode on an already-synced repo writes nothing and says so", async () => {
		// WHY: idempotence — a no-op sync must not rewrite files (which would churn
		// git blame and could fight the formatter). The 'already in sync' branch.
		const res = await runScript(MODULE, { files: inSyncFiles(), argv: [] });
		expect(res.exitCode).toBeUndefined();
		expect(res.writes).toEqual([]);
		expect(res.stdout).toContain("Versions already in sync.");
	});

	it("throws when mise.toml [tools] has no entry for a required tool (fail loud)", async () => {
		// WHY: a mise.toml missing the node/pnpm pin is a broken source of truth;
		// the script must abort loudly, not silently mirror an empty version.
		const files = new Map<string, string>([
			["mise.toml", '[tools]\n"pnpm" = "10.2.0"\n'], // node absent
			[".nvmrc", "x\n"],
			["package.json", "{}\n"],
		]);
		let result: HarnessResult | undefined;
		let thrown: unknown;
		try {
			result = await runScript(MODULE, { files, argv: ["--check"] });
		} catch (error) {
			thrown = error;
		}
		// The module throws at top level (not a process.exit); the harness rethrows
		// anything that is not the exit sentinel.
		expect(result).toBeUndefined();
		expect(String(thrown)).toContain('no [tools] entry for "node"');
	});

	it("ignores a [tools]-named key appearing OUTSIDE the [tools] table (section scoping)", async () => {
		// WHY: `readToolVersion` only trusts the [tools] section. A `node = "x"` in
		// [env] (added as a decoy in every fixture) must NOT be mistaken for the pin —
		// otherwise section scoping is broken and the wrong version leaks through.
		const files = inSyncFiles();
		const res = await runScript(MODULE, { files, argv: ["--check"] });
		// The decoy [env] node value would have produced drift; in-sync proves the
		// real [tools] node ("22.1.0") was used.
		expect(res.exitCode).toBeUndefined();
		expect(res.stdout).toContain("Versions are in sync.");
	});

	it("--check FAILS (exit 1) when a SUB-package declares its own engines (root-only anchor guard)", async () => {
		// WHY: node/pnpm are pinned once at the root package.json (the workspace
		// anchor). A sub-package re-declaring `engines` would fragment those pins
		// across the monorepo — the multi-package drift this guard exists to block.
		const files = inSyncFiles();
		files.set(
			"packages/shared/utils/qa/package.json",
			`${JSON.stringify({ name: "@foundation/qa", engines: { node: "20.0.0" } }, null, "\t")}\n`,
		);
		const res = await runScript(MODULE, {
			files,
			argv: ["--check"],
			spawnSync: gitLsFiles("package.json\npackages/shared/utils/qa/package.json\n"),
		});
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain(
			"packages/shared/utils/qa/package.json: a sub-package must NOT declare",
		);
		expect(res.writes).toEqual([]);
	});

	it("passes when sub-packages declare NO engines (they inherit the root anchor)", async () => {
		// WHY: the healthy multi-package state — sub-packages omit engines and inherit
		// the root pin; the guard must not false-positive. Also exercises the
		// node_modules skip (a vendored package.json is never a workspace member).
		const files = inSyncFiles();
		files.set(
			"packages/shared/utils/qa/package.json",
			`${JSON.stringify({ name: "@foundation/qa" }, null, "\t")}\n`,
		);
		const res = await runScript(MODULE, {
			files,
			argv: ["--check"],
			spawnSync: gitLsFiles(
				"package.json\npackages/shared/utils/qa/package.json\nnode_modules/x/package.json\n",
			),
		});
		expect(res.exitCode).toBeUndefined();
		expect(res.stdout).toContain("Versions are in sync.");
	});

	it("write mode ALSO fails (exit 1) on a sub-package engines violation — it can't auto-fix it", async () => {
		// WHY: removing a stray sub-package `engines` is a human decision, so even the
		// write path surfaces it and exits non-zero rather than silently leaving the
		// split-brain (derived files are still written first; only the engine problem
		// blocks). Covers the write-mode engine-problem branch.
		const files = inSyncFiles(); // derived already in-sync → no version writes
		files.set(
			"packages/shared/utils/qa/package.json",
			`${JSON.stringify({ name: "@foundation/qa", engines: { pnpm: "9.0.0" } }, null, "\t")}\n`,
		);
		const res = await runScript(MODULE, {
			files,
			argv: [],
			spawnSync: gitLsFiles("package.json\npackages/shared/utils/qa/package.json\n"),
		});
		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain("a sub-package must NOT declare");
	});
});
