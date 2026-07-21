/**
 * Dedicated vitest config for the QA gate-integrity meta-test (`pnpm qa:gates`).
 *
 * The root vitest.config.ts EXCLUDES gate-integrity.test.ts from the main suite:
 * it forks the real lint/format/schema gates and a nested `vitest run
 * --coverage`, which has no place inside the ordinary `test` / coverage pass.
 * vitest applies a config's `exclude` even to a file named explicitly on the CLI
 * (a positional is a filter over the collected set, not an override), so the
 * meta-test cannot be reached by `vitest run <path>` against the root config — it
 * needs its own include here. This config carries NO coverage gate of its own;
 * the gate under test is the one the meta-test forks, not this run.
 *
 * @module
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		pool: "forks",
		// The meta-test mutates process.cwd and re-imports gate modules; keep its
		// cases in one file serial, matching the root config's posture.
		fileParallelism: false,
		// Each coverage case forks a full `vitest run --coverage`; the default 5s is
		// far too tight for a cold child vitest plus v8 instrumentation.
		testTimeout: 120_000,
		include: ["packages/shared/utils/qa/tests/gate-integrity.test.ts"],
	},
});
