#!/usr/bin/env node
/**
 * Full local CI verification via act (nektos/act): runs the whole `ci.yml`
 * workflow in Docker, exactly as GitHub would, then tears itself down. Backs the
 * `pnpm ci:local` script; `pnpm ci:local:clean` (`--clean`) additionally purges
 * the cached runner image + act's action cache for a zero-footprint teardown.
 *
 * act is a LOCAL dev tool, not a CI/runtime dependency, so it is deliberately NOT
 * pinned in the project `mise.toml` — it is installed globally on demand (into the
 * gitignored `.mise/`), which keeps the committed toolchain (and real CI) untouched.
 *
 * @module
 */

import { miseExec, repoRoot } from "@foundation/core";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";

const ROOT = repoRoot();
const IMAGE = "catthehacker/ubuntu:act-latest";
const ACT_TOOL = "aqua:nektos/act@0.2.89";
const ACT_CACHE = join(homedir(), ".cache", "act");
// act's built-in cache server (used by actions/cache@v4). Separate from
// ACT_CACHE above, which holds pre-cloned actions. A polluted workflow-cache
// entry (e.g. `.mise/` restored across runs with host-relative symlinks)
// keeps broken installs alive inside the container until this directory is
// wiped, so `--clean` has to reach both paths.
const ACT_WORKFLOW_CACHE = join(homedir(), ".cache", "actcache");

// act must fetch these actions to run ci.yml. We pre-clone them into act's cache
// with the credential helper disabled — an ambient git credential helper can make
// act's own go-git clone of the PUBLIC action repos fail with a bogus auth error —
// and run with `--action-offline-mode` so act uses the cached copies instead.
const ACTIONS: ReadonlyArray<{ repo: string; dir: string; ref: string }> = [
	{ repo: "actions/checkout", dir: "actions-checkout@v4", ref: "v4" },
	{ repo: "actions/cache", dir: "actions-cache@v4", ref: "v4" },
];

// Run a host command in the repo root.
function sh(
	cmd: string,
	args: readonly string[],
	opts: Record<string, unknown> = {},
): SpawnSyncReturns<string> {
	return spawnSync(cmd, [...args], { cwd: ROOT, encoding: "utf8", ...opts });
}

// Is the Docker daemon reachable?
function dockerUp(): boolean {
	return (
		sh("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0
	);
}

// Remove any act job containers. act KEEPS failed-job containers unless `--rm`, so
// this reaps whatever a crashed or interrupted run left behind.
function removeActContainers(): void {
	const ids = sh("docker", ["ps", "-aq", "--filter", "name=act-"])
		.stdout.split("\n")
		.filter(Boolean);
	if (ids.length > 0) {
		sh("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
	}
}

// Full teardown: containers + the cached runner image + act's action cache +
// act's workflow-cache server directory (`~/.cache/actcache`). Skipping the
// latter kept broken tool installs alive across runs; wiping both makes the
// clean idempotent.
function clean(): void {
	removeActContainers();
	sh("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
	rmSync(ACT_CACHE, { recursive: true, force: true });
	rmSync(ACT_WORKFLOW_CACHE, { recursive: true, force: true });
	stdout.write(
		"ci:local: torn down — containers, runner image, action cache, and workflow cache removed.\n",
	);
}

// Install act globally via mise if it is not already available, keeping it out of
// the pinned project toolchain.
function ensureAct(): void {
	if (miseExec(["act", "--version"], { stdio: "ignore" }).status === 0) {
		return;
	}
	stdout.write("ci:local: installing act (nektos/act) via mise…\n");
	sh(join(ROOT, "bin/mise"), ["use", "-g", ACT_TOOL], { stdio: "inherit" });
}

// Pre-populate act's action cache so `--action-offline-mode` has the actions
// ci.yml needs, bypassing act's auth-fragile self-clone.
function ensureActionCache(): void {
	for (const action of ACTIONS) {
		const dest = join(ACT_CACHE, action.dir);
		if (!existsSync(dest)) {
			stdout.write(`ci:local: caching ${action.repo}@${action.ref}…\n`);
			sh(
				"git",
				[
					"-c",
					"credential.helper=",
					"clone",
					"--quiet",
					"--depth",
					"1",
					"--branch",
					action.ref,
					`https://github.com/${action.repo}`,
					dest,
				],
				{ stdio: "inherit" },
			);
		}
	}
}

// Run the whole ci.yml in Docker via act, then reap containers. Returns act's exit
// code. `--rm` removes containers/volumes even on a job failure; `--action-offline-mode`
// uses the pre-cached actions. The job steps install the toolchain + deps INSIDE the
// container, so the heavy dirs live there regardless of what act copies — gitleaks
// stays clean via its allowlist (packages/shared/config/gitleaks.toml), not a copy flag.
// `-W .github/workflows/ci.yml` scopes act to ci.yml so notification workflows that
// require production-only secrets (e.g. catalog-notify) don't fail locally.
function runAct(): number {
	stdout.write(`ci:local: running the full CI workflow in ${IMAGE} via act…\n`);
	const result = miseExec(
		[
			"act",
			"push",
			"-W",
			".github/workflows/ci.yml",
			"-P",
			`ubuntu-latest=${IMAGE}`,
			"--rm",
			"--action-offline-mode",
		],
		{ stdio: "inherit" },
	);
	removeActContainers();
	return result.status ?? 1;
}

// Entry point. `--clean` runs the full teardown; otherwise runs the workflow.
export function ciLocal(args: readonly string[]): number {
	if (args.includes("--clean")) {
		if (dockerUp()) {
			clean();
		} else {
			rmSync(ACT_CACHE, { recursive: true, force: true });
			rmSync(ACT_WORKFLOW_CACHE, { recursive: true, force: true });
			stdout.write(
				"ci:local: Docker not running — removed both action + workflow caches; no containers/image to reap.\n",
			);
		}
		return 0;
	}
	if (!dockerUp()) {
		stderr.write("ci:local: Docker is not running. Start Docker Desktop and retry.\n");
		return 1;
	}
	ensureAct();
	ensureActionCache();
	return runAct();
}

// thin CLI guard — run only when executed directly, not when imported by tests.
if (import.meta.filename === argv[1]) {
	exit(ciLocal(argv.slice(2)));
}
