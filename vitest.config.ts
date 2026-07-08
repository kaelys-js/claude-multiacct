/**
 * Vitest configuration for foundation-registry.
 *
 * foundation-registry is a SINGLE-PACKAGE repo (not a workspace), so there is no
 * `projects` array — one config drives the whole suite. Tests live in
 * `scripts/**` (the QA/sync tooling) and `tests/**` (the record validator).
 *
 * Coverage gates the push: `pnpm qa:test:coverage` (lefthook pre-push + CI)
 * exits non-zero below the thresholds. `perFile: true` means EVERY covered file
 * must clear the floor — a well-covered file can't mask an untested one. The
 * coverage `include` is ALL of `scripts/**` (the qa/sync IO tooling included) so
 * the whole toolchain is held to the same bar, not just the pure helpers.
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
		passWithNoTests: false,
		include: ["scripts/**/*.test.ts", "tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "json-summary", "lcov", "html"],
			reportsDirectory: "coverage",
			// ALL scripts — the qa/sync IO tooling is coverage-gated too, not just the
			// pure helpers. Test files, type decls, and tool config files are excluded.
			include: ["scripts/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "scripts/**/*.config.ts"],
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
