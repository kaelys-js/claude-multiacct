/**
 * Vitest configuration for foundation-registry.
 *
 * foundation-registry is a pnpm WORKSPACE, but ONE config drives the whole suite
 * (no `projects` array — every package runs in the same node env, so a single pass
 * covers them all and the built-in coverage gate stays exit-code-correct). Every
 * test lives under `packages/**`; the `@foundation/*` cross-package imports resolve
 * through the workspace symlinks + each package's `exports` map, no path aliases.
 *
 * Coverage gates the push: `pnpm qa:test:coverage` (lefthook pre-push + CI)
 * exits non-zero below the thresholds — the gate is vitest's own exit code, there
 * is no external assert-script. `perFile: true` means EVERY covered file must clear
 * the floor independently, and with `coverage.all` on (v8 default) an untested
 * `src` file counts as 0% rather than being skipped — so neither a well-covered
 * file nor a wholly-missing test can mask an undertested module. The `include` is
 * every package's `src/**`, so the whole toolchain is held to one bar.
 *
 * @module
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		pool: "forks",
		isolate: true,
		// Run test FILES serially (tests within a file still run together). Several
		// QA integration tests mutate the SHARED real-repo git index — gitmeta-check's
		// `git add --renormalize .` + `git reset`, plus chdir-based git fixtures — which
		// is not safe across parallel forks sharing one `.git` (index.lock contention →
		// flaky failures). The scripts themselves run single-process in prod; this only
		// affects test execution.
		fileParallelism: false,
		passWithNoTests: false,
		// Bumped from vitest's 5s default: `schema-check.test.ts` under act's
		// Ubuntu container fetches vendored schemas over the network on some
		// runs, which can push a single case past 5s and flake the whole
		// pre-push. 10s gives the slower path headroom without letting a
		// genuinely stuck test hang indefinitely.
		testTimeout: 10_000,
		include: ["packages/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "json-summary", "lcov", "html"],
			reportsDirectory: "coverage",
			// ALL toolchain source — the qa/sync IO tooling is coverage-gated too, not
			// just the pure helpers. Test files and type decls are excluded.
			//
			// TRP's fix-task.ts is excluded from the per-file gate on Cole's
			// directive: the coverage debt is real (around 21% lines, 40%
			// functions), the tests are queued under ROADMAP Item 20, and the
			// gate would otherwise stop every push against this repo until that
			// queue clears. Loud in the config so nobody mistakes the exclusion
			// for "this file doesn't need coverage".
			include: ["packages/**/src/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/*.d.ts",
				"packages/products/trp/src/scripts/fix-task.ts",
				// PR6b real-port wiring for the bundled cma CLI. Every function
				// binds a real-fs / real-launchctl / real-process surface that
				// would need shelling out to test in isolation; the pure command
				// modules it wraps (install/uninstall/launch/migrate) carry the
				// coverage. Bundled-CLI happy paths are exercised in
				// build-cli.test.ts against a spawned node process.
				"packages/products/claude-multiacct/src/cli/wiring.ts",
			],
			// perFile: every covered file must clear the floor independently, so a
			// well-covered file can't average out an untested one.
			thresholds: {
				lines: 90,
				functions: 90,
				branches: 90,
				statements: 90,
				perFile: true,
			},
		},
	},
});
