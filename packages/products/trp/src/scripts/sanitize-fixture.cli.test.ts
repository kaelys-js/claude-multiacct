// CLI-entry coverage for `sanitize-fixture.ts`. Mirrors the direct-run
// coverage pattern used for `emit-trp-failure.cli.test.ts` and
// `codeowners-reviewers.cli.test.ts`: reset the module registry, retarget
// `process.argv[1]`, mock `process.exit` as a recorder, then dynamically
// re-import so v8 attributes the top-level `if (isDirectRun()) { ... }`
// branches to a running test.
//
// The module-under-test reads real stdin via `readFileSync(0, "utf8")`.
// Every CLI test that reaches `main()`'s stdin path routes through the
// hoisted `stdinRef` seam so `node:fs` is intercepted at the module
// boundary — vitest's ESM namespace lockdown blocks `vi.spyOn` on
// `node:fs.readFileSync`, so `vi.mock` + `vi.hoisted` is the pattern.

/* oxlint-disable typescript/explicit-function-return-type, typescript/consistent-type-imports */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mutable slot the mocked `node:fs.readFileSync` reads on every
// fd-0 call. Assignable from any test body — the mock's factory captures
// the reference at hoist time so later mutations take effect.
const { stdinRef } = vi.hoisted(() => ({
	stdinRef: { value: "" as string | Error },
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: (target: unknown, ...rest: unknown[]) => {
			if (target === 0) {
				const current = stdinRef.value;
				if (current instanceof Error) {
					throw current;
				}
				return current;
			}
			return (
				actual.readFileSync as (..._args: unknown[]) => ReturnType<typeof actual.readFileSync>
			)(target, ...rest);
		},
	};
});

const HERE = import.meta.dirname;
const MODULE_PATH = resolve(HERE, "sanitize-fixture.ts");
const NODE_BIN = process.argv[0] ?? "node";

describe("sanitize-fixture direct-run entry", () => {
	const originalArgv = process.argv;
	let scratch: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "sf-cli-"));
		exitCodes = [];
		stdinRef.value = "";
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
	});

	// isDirectRun -> false via !entry: module top-level does nothing.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import("./sanitize-fixture.ts");
		expect(exitCodes).toEqual([]);
	});

	// isDirectRun -> false via realpathSync catch on a non-existent entry.
	it("skips main() when argv[1] cannot be realpath'd", async () => {
		process.argv = [NODE_BIN, join(scratch, "ghost")];
		await import("./sanitize-fixture.ts");
		expect(exitCodes).toEqual([]);
	});

	// Direct-run happy path: valid manifest + intercepted stdin. main() returns
	// 0 and the wrapper exits(0). Covers `const code = main(); process.exit(code)`.
	it("runs main() and exits(0) when the manifest and stdin are both valid", async () => {
		const manifestPath = join(scratch, "manifest.json");
		writeFileSync(manifestPath, "{}");
		stdinRef.value = "hello stdin";
		process.argv = [NODE_BIN, MODULE_PATH, manifestPath];
		await import("./sanitize-fixture.ts");
		expect(exitCodes).toEqual([0]);
	});

	// Direct-run argv-error: main() catches SanitizeExit(2) from
	// requireManifestPath and returns 2 without touching stdin. The wrapper
	// exits(2).
	it("exits(2) when the direct-run wrapper hits a bad argv", async () => {
		process.argv = [NODE_BIN, MODULE_PATH]; // no manifest positional
		await import("./sanitize-fixture.ts");
		expect(exitCodes).toEqual([2]);
	});

	// Direct-run manifest-error: main() catches SanitizeExit(3) and returns
	// 3 without touching stdin. Wrapper exits(3).
	it("exits(3) when the manifest is missing", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, join(scratch, "does-not-exist.json")];
		await import("./sanitize-fixture.ts");
		expect(exitCodes).toEqual([3]);
	});

	// Direct-run stdin-error: readStdinSync throws SanitizeExit(4) via the
	// intercepted fd-0 read; main() catches and returns 4. Wrapper exits(4).
	it("exits(4) when the stdin read fails", async () => {
		const manifestPath = join(scratch, "manifest.json");
		writeFileSync(manifestPath, "{}");
		stdinRef.value = new Error("stdin read boom");
		process.argv = [NODE_BIN, MODULE_PATH, manifestPath];
		await import("./sanitize-fixture.ts");
		expect(exitCodes).toEqual([4]);
	});
});
