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

import { configDefaults, defineConfig } from "vitest/config";

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
		// gate-integrity.test.ts is the QA gates' own meta-test: it spawns the real
		// lint/format/schema/coverage gates against synthetic-failure fixtures, and
		// the coverage case forks a nested `vitest run --coverage`. That belongs to
		// the dedicated `qa:gates` script/CI job, not the main suite — running it
		// here would nest a vitest-inside-vitest coverage pass on every `test` run.
		// Kept out of the `packages/**/*.test.ts` glob while preserving vitest's
		// built-in ignores (node_modules, dist, …).
		exclude: [...configDefaults.exclude, "packages/shared/utils/qa/tests/gate-integrity.test.ts"],
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
			//
			// claude-multiacct's cli/wiring.ts is excluded for a different
			// reason (2026-07-21): it is the product's composition root — a
			// single 700-line wiring function that binds the real shim, watcher,
			// daemon, and extension ports (node:fs, execFile, launchctl) into the
			// installer graph. A test over it could only assert the wiring SHAPE,
			// not behaviour; the behaviour lives in the installer modules it
			// composes, each already covered at >=97%. Excluding the root keeps
			// the gate honest about the modules that carry logic instead of
			// inflating it with a mock-the-world assertion. The file's own
			// docstring already declared it coverage-excluded; this makes the
			// config agree.
			include: ["packages/**/src/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/*.d.ts",
				"packages/products/trp/src/scripts/fix-task.ts",
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
