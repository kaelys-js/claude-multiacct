// Behaviour tests for `sanitize-fixture.ts` (Phase 6 fixture scrub pipeline).
//
// WHY it matters: this script sits on both sides of the G0 dual-run diff and
// on every parity assertion for the six composed-run modes. A scrub_rule
// applied in the wrong order, a structural_shape_only path that leaks its
// bytes, or an exit-code drift and the whole parity harness misreads shell
// output as "unstable" when it's actually stable. Every rule, every path
// convention, and every exit code is asserted here so the fixture harness
// downstream can trust the tool.
//
// Coverage: exported helpers (loadManifest, applyScrubRules, structuralMarker,
// applyStructuralShape, runPipeline, requireManifestPath, readStdinSync), plus
// end-to-end main() paths driven through the `stdinContent` seam so real
// stdin never has to be piped from a spec.
//
// Error model: helpers throw {@link SanitizeExit}; tests catch it and assert
// the `code` field. main() returns the numeric code and the wrapper (tested
// in `.cli.test.ts`) calls `process.exit`.

/* oxlint-disable vitest/expect-expect, vitest/no-conditional-expect, unicorn/consistent-function-scoping */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fnv1a64 } from "../workflows/sanitize.ts";
import {
	applyScrubRules,
	applyStructuralShape,
	BASE_SCRUB_RULES,
	loadManifest,
	main,
	readStdinSync,
	requireManifestPath,
	runPipeline,
	SanitizeExit,
	structuralMarker,
} from "./sanitize-fixture.ts";

describe("sanitize-fixture", () => {
	let scratch: string;
	let savedArgv: string[];
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "sanitize-fixture-"));
		savedArgv = process.argv;
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		process.argv = savedArgv;
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
	});

	const stdoutText = (): string =>
		stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	const stderrText = (): string =>
		stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

	function expectExit<T>(fn: () => T, code: number): SanitizeExit {
		try {
			fn();
		} catch (error) {
			expect(error).toBeInstanceOf(SanitizeExit);
			const exit = error as SanitizeExit;
			expect(exit.code).toBe(code);
			return exit;
		}
		throw new Error(`expected SanitizeExit(${code}) but the call returned normally`);
	}

	// ---------------------------------------------------------------------
	// SanitizeExit
	// ---------------------------------------------------------------------

	describe("SanitizeExit", () => {
		it("carries the code and message and is a real Error subclass", () => {
			const err = new SanitizeExit(3, "manifest missing");
			expect(err).toBeInstanceOf(Error);
			expect(err.code).toBe(3);
			expect(err.message).toBe("manifest missing");
			expect(err.name).toBe("SanitizeExit");
		});
	});

	// ---------------------------------------------------------------------
	// BASE_SCRUB_RULES
	// ---------------------------------------------------------------------

	describe("BASE_SCRUB_RULES", () => {
		it("is an empty tuple so per-fixture manifests are the sole source of truth", () => {
			expect(BASE_SCRUB_RULES).toEqual([]);
		});
	});

	// ---------------------------------------------------------------------
	// loadManifest
	// ---------------------------------------------------------------------

	describe("loadManifest", () => {
		it("returns normalised {scrub_rules, structural_shape_only} for a valid manifest", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(
				path,
				JSON.stringify({
					scrub_rules: [
						{
							pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
							replacement: "<ISO-TS>",
							reason: "timestamps",
						},
					],
					structural_shape_only: ["log_body_md", "prompt_body"],
				}),
			);
			const manifest = loadManifest(path);
			expect(manifest.scrub_rules).toEqual([
				{
					pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
					replacement: "<ISO-TS>",
					reason: "timestamps",
				},
			]);
			expect(manifest.structural_shape_only).toEqual(["log_body_md", "prompt_body"]);
		});

		it("defaults both fields to empty arrays when the manifest is `{}`", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, "{}");
			const manifest = loadManifest(path);
			expect(manifest.scrub_rules).toEqual([]);
			expect(manifest.structural_shape_only).toEqual([]);
		});

		it("throws SanitizeExit(3) when the manifest file does not exist", () => {
			const missing = join(scratch, "does-not-exist.json");
			expectExit(() => loadManifest(missing), 3);
			expect(stderrText()).toContain("manifest not found");
		});

		it("throws SanitizeExit(3) when the manifest is not valid JSON", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, "{not-json");
			expectExit(() => loadManifest(path), 3);
			expect(stderrText()).toContain("invalid JSON");
		});

		it("throws SanitizeExit(3) when the manifest root is not a JSON object", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, JSON.stringify([1, 2, 3]));
			expectExit(() => loadManifest(path), 3);
			expect(stderrText()).toContain("must be a JSON object");
		});

		it("throws SanitizeExit(3) when the manifest root is a JSON null", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, "null");
			expectExit(() => loadManifest(path), 3);
		});

		it("throws SanitizeExit(3) when scrub_rules is not an array", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, JSON.stringify({ scrub_rules: "oops" }));
			expectExit(() => loadManifest(path), 3);
			expect(stderrText()).toContain("scrub_rules must be an array");
		});

		it("throws SanitizeExit(3) when a scrub_rule entry is not an object", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, JSON.stringify({ scrub_rules: [1] }));
			expectExit(() => loadManifest(path), 3);
			expect(stderrText()).toContain("scrub_rules[0] must be an object");
		});

		it("throws SanitizeExit(3) when a scrub_rule is missing pattern/replacement/reason", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(
				path,
				JSON.stringify({
					scrub_rules: [{ pattern: "x", replacement: "y" /* reason missing */ }],
				}),
			);
			expectExit(() => loadManifest(path), 3);
			expect(stderrText()).toContain(
				"scrub_rules[0] missing {pattern, replacement, reason} strings",
			);
		});

		it("throws SanitizeExit(3) when structural_shape_only is not an array", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, JSON.stringify({ structural_shape_only: {} }));
			expectExit(() => loadManifest(path), 3);
			expect(stderrText()).toContain("structural_shape_only must be an array");
		});

		it("throws SanitizeExit(3) when a structural_shape_only entry is not a string", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(path, JSON.stringify({ structural_shape_only: [1] }));
			expectExit(() => loadManifest(path), 3);
			expect(stderrText()).toContain("structural_shape_only[0] must be a string");
		});

		it("normalises to empty arrays when only one field is present", () => {
			const path = join(scratch, "manifest.json");
			writeFileSync(
				path,
				JSON.stringify({
					scrub_rules: [{ pattern: "x", replacement: "y", reason: "z" }],
				}),
			);
			const manifest = loadManifest(path);
			expect(manifest.scrub_rules).toHaveLength(1);
			expect(manifest.structural_shape_only).toEqual([]);
		});
	});

	// ---------------------------------------------------------------------
	// applyScrubRules
	// ---------------------------------------------------------------------

	describe("applyScrubRules", () => {
		it("applies rules in order (later rules see earlier replacements)", () => {
			const rules = [
				{ pattern: "foo", replacement: "bar", reason: "1st" },
				{ pattern: "bar", replacement: "baz", reason: "2nd" },
			];
			expect(applyScrubRules("foo", rules)).toBe("baz");
		});

		it("uses the global flag so every match in the input is replaced", () => {
			const rules = [{ pattern: "x", replacement: "y", reason: "everywhere" }];
			expect(applyScrubRules("xxx", rules)).toBe("yyy");
		});

		it("uses the unicode flag so surrogate pairs match correctly", () => {
			const rules = [{ pattern: "\\p{Emoji_Presentation}", replacement: "_", reason: "emoji" }];
			// Actual emoji whose regex-class match requires the `u` flag.
			expect(applyScrubRules("a\u{1F600}b", rules)).toBe("a_b");
		});

		it("returns the input unchanged when no rules are supplied", () => {
			expect(applyScrubRules("hello world", [])).toBe("hello world");
		});

		it("scrubs an ISO timestamp with the plan's example rule", () => {
			const rules = [
				{
					pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
					replacement: "<ISO-TS>",
					reason: "timestamps",
				},
			];
			expect(applyScrubRules("finished at 2026-07-10T12:34:56Z after two retries", rules)).toBe(
				"finished at <ISO-TS> after two retries",
			);
		});

		it("throws SanitizeExit(3) when a rule pattern does not compile", () => {
			const rules = [{ pattern: "([bad-regex", replacement: "x", reason: "unbalanced group" }];
			expectExit(() => applyScrubRules("input", rules), 3);
			expect(stderrText()).toContain("not a valid regex");
			expect(stderrText()).toContain("unbalanced group");
		});
	});

	// ---------------------------------------------------------------------
	// structuralMarker
	// ---------------------------------------------------------------------

	describe("structuralMarker", () => {
		it("emits {sanitized, len, hash} for a string with the fnv1a-16hex hash", () => {
			const marker = structuralMarker("hello");
			expect(marker.sanitized).toBe(true);
			expect(marker.len).toBe(5);
			expect(marker.hash).toBe(`fnv1a-${fnv1a64("hello")}`);
			expect(marker.hash).toMatch(/^fnv1a-[0-9a-f]{16}$/u);
		});

		it("uses element count for arrays and hashes the JSON serialisation", () => {
			const value = ["a", "b", "c"];
			const marker = structuralMarker(value);
			expect(marker.len).toBe(3);
			expect(marker.hash).toBe(`fnv1a-${fnv1a64(JSON.stringify(value))}`);
		});

		it("uses key count for objects and hashes the JSON serialisation", () => {
			const value = { a: 1, b: 2 };
			const marker = structuralMarker(value);
			expect(marker.len).toBe(2);
			expect(marker.hash).toBe(`fnv1a-${fnv1a64(JSON.stringify(value))}`);
		});

		it("hashes scalar JSON forms for numbers, booleans, and null", () => {
			expect(structuralMarker(42).hash).toBe(`fnv1a-${fnv1a64("42")}`);
			expect(structuralMarker(true).hash).toBe(`fnv1a-${fnv1a64("true")}`);
			expect(structuralMarker(null).hash).toBe(`fnv1a-${fnv1a64("null")}`);
			// len for scalars is the length of the JSON form: "42".length === 2.
			expect(structuralMarker(42).len).toBe(2);
			expect(structuralMarker(true).len).toBe(4);
			expect(structuralMarker(null).len).toBe(4);
		});

		it("collapses the empty string to len=0 and a stable hash", () => {
			const marker = structuralMarker("");
			expect(marker.len).toBe(0);
			expect(marker.hash).toBe(`fnv1a-${fnv1a64("")}`);
		});
	});

	// ---------------------------------------------------------------------
	// applyStructuralShape
	// ---------------------------------------------------------------------

	describe("applyStructuralShape", () => {
		it("returns the value unchanged when the paths list is empty", () => {
			const value = { a: 1, b: [2, 3] };
			expect(applyStructuralShape(value, [])).toEqual(value);
		});

		it("collapses a top-level key to a sanitize marker", () => {
			const value = { log_body_md: "very long log content here...", other: "keep" };
			const out = applyStructuralShape(value, ["log_body_md"]) as Record<string, unknown>;
			expect(out.other).toBe("keep");
			expect(out.log_body_md).toEqual(structuralMarker(value.log_body_md));
		});

		it("collapses a nested path", () => {
			const value = { a: { b: { c: "leaf" } } };
			const out = applyStructuralShape(value, ["a/b/c"]) as {
				a: { b: { c: unknown } };
			};
			expect(out.a.b.c).toEqual(structuralMarker("leaf"));
		});

		it("collapses an array element by numeric index", () => {
			const value = { list: ["keep", "collapse", "keep-too"] };
			const out = applyStructuralShape(value, ["list/1"]) as { list: unknown[] };
			expect(out.list[0]).toBe("keep");
			expect(out.list[1]).toEqual(structuralMarker("collapse"));
			expect(out.list[2]).toBe("keep-too");
		});

		it("collapses the ROOT when the path is the empty string", () => {
			const value = { a: 1 };
			expect(applyStructuralShape(value, [""])).toEqual(structuralMarker(value));
		});

		it("preserves object key insertion order", () => {
			const value = { z: "leaf", a: { collapse: "x" }, m: 1 };
			const out = applyStructuralShape(value, ["a/collapse"]) as Record<string, unknown>;
			expect(Object.keys(out)).toEqual(["z", "a", "m"]);
		});

		it("preserves array order for non-collapsed elements", () => {
			const value = ["a", "b", "c", "d"];
			const out = applyStructuralShape(value, ["2"]) as unknown[];
			expect(out[0]).toBe("a");
			expect(out[1]).toBe("b");
			expect(out[3]).toBe("d");
		});

		it("passes through scalars at non-target paths", () => {
			const value = { a: 1, b: true, c: null };
			expect(applyStructuralShape(value, ["missing"])).toEqual(value);
		});

		it("handles arrays as the root without a target path", () => {
			const value = [1, 2, 3];
			expect(applyStructuralShape(value, ["missing"])).toEqual(value);
		});
	});

	// ---------------------------------------------------------------------
	// runPipeline
	// ---------------------------------------------------------------------

	describe("runPipeline", () => {
		it("applies scrub_rules only when structural_shape_only is empty (bytes pass through)", () => {
			const manifest = {
				scrub_rules: [
					{
						pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
						replacement: "<ISO-TS>",
						reason: "timestamps",
					},
				],
				structural_shape_only: [],
			};
			expect(runPipeline("t=2026-07-10T12:34:56Z", manifest)).toBe("t=<ISO-TS>");
		});

		it("returns the SCRUBBED input unchanged when it doesn't parse as JSON even with structural_shape_only set", () => {
			const manifest = {
				scrub_rules: [{ pattern: "foo", replacement: "bar", reason: "" }],
				structural_shape_only: ["something"],
			};
			expect(runPipeline("hello foo world", manifest)).toBe("hello bar world");
		});

		it("scrubs, then walks JSON, replacing values at structural_shape_only paths with markers", () => {
			const manifest = {
				scrub_rules: [
					{
						pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
						replacement: "<ISO-TS>",
						reason: "timestamps",
					},
				],
				structural_shape_only: ["log_body_md"],
			};
			const input = JSON.stringify({
				ts: "2026-07-10T12:34:56Z",
				log_body_md: "the long log content that we want to collapse",
			});
			const out = runPipeline(input, manifest);
			expect(out.endsWith("\n")).toBe(true);
			const parsed = JSON.parse(out) as Record<string, unknown>;
			expect(parsed.ts).toBe("<ISO-TS>");
			const marker = parsed.log_body_md as Record<string, unknown>;
			expect(marker.sanitized).toBe(true);
			expect(marker.len).toBe("the long log content that we want to collapse".length);
		});

		it("scrub_rules run BEFORE structural_shape_only so scrubs can hit the raw content first", () => {
			const manifest = {
				scrub_rules: [{ pattern: "secret", replacement: "<REDACTED>", reason: "leak" }],
				structural_shape_only: ["body"],
			};
			const input = JSON.stringify({ body: "value with a secret token in the middle" });
			const out = runPipeline(input, manifest);
			const parsed = JSON.parse(out) as { body: { hash: string } };
			// The marker fingerprints the SCRUBBED content, so its hash matches
			// fnv1a64 of the post-scrub string, not the raw one.
			const scrubbed = "value with a <REDACTED> token in the middle";
			expect(parsed.body.hash).toBe(`fnv1a-${fnv1a64(scrubbed)}`);
		});

		it("passes stdin through unchanged when the manifest has no rules and no structural paths", () => {
			const manifest = { scrub_rules: [], structural_shape_only: [] };
			const input = "arbitrary bytes\r\nwith newlines\n";
			expect(runPipeline(input, manifest)).toBe(input);
		});
	});

	// ---------------------------------------------------------------------
	// requireManifestPath
	// ---------------------------------------------------------------------

	describe("requireManifestPath", () => {
		it("returns the sole positional argument", () => {
			expect(requireManifestPath(["/tmp/manifest.json"])).toBe("/tmp/manifest.json");
		});

		it("throws SanitizeExit(2) with usage on zero arguments", () => {
			expectExit(() => requireManifestPath([]), 2);
			expect(stderrText()).toContain("usage: sanitize-fixture");
		});

		it("throws SanitizeExit(2) with usage on two or more arguments", () => {
			expectExit(() => requireManifestPath(["a.json", "b.json"]), 2);
		});

		it("throws SanitizeExit(2) when the arg looks like a flag", () => {
			expectExit(() => requireManifestPath(["--help"]), 2);
		});
	});

	// ---------------------------------------------------------------------
	// readStdinSync — cannot be safely driven from a unit test (fd 0 is
	// inherited from the vitest runner), but we can at least assert the
	// function exists and is a function. The exit-4 path is exercised via
	// the CLI test which mocks readFileSync at the module boundary.
	// ---------------------------------------------------------------------

	describe("readStdinSync", () => {
		it("is exported as a function so the CLI wrapper can call it", () => {
			expect(typeof readStdinSync).toBe("function");
		});
	});

	// ---------------------------------------------------------------------
	// main() — end-to-end via stdinContent seam
	// ---------------------------------------------------------------------

	describe("main", () => {
		it("writes the scrubbed bytes to stdout and returns 0 on the happy path", () => {
			const manifestPath = join(scratch, "manifest.json");
			writeFileSync(
				manifestPath,
				JSON.stringify({
					scrub_rules: [
						{
							pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
							replacement: "<ISO-TS>",
							reason: "timestamps",
						},
					],
				}),
			);
			process.argv = ["node", "sanitize-fixture", manifestPath];
			const code = main({ stdinContent: "at 2026-07-10T12:34:56Z" });
			expect(code).toBe(0);
			expect(stdoutText()).toBe("at <ISO-TS>");
		});

		it("returns 2 when argv has no positional", () => {
			process.argv = ["node", "sanitize-fixture"];
			expect(main({ stdinContent: "" })).toBe(2);
		});

		it("returns 3 when the manifest is missing", () => {
			process.argv = ["node", "sanitize-fixture", join(scratch, "nope.json")];
			expect(main({ stdinContent: "" })).toBe(3);
		});

		it("returns 3 when the manifest is malformed JSON", () => {
			const manifestPath = join(scratch, "manifest.json");
			writeFileSync(manifestPath, "{not-json");
			process.argv = ["node", "sanitize-fixture", manifestPath];
			expect(main({ stdinContent: "" })).toBe(3);
		});

		it("emits JSON with markers when structural_shape_only fires end-to-end", () => {
			const manifestPath = join(scratch, "manifest.json");
			writeFileSync(
				manifestPath,
				JSON.stringify({
					structural_shape_only: ["body"],
				}),
			);
			process.argv = ["node", "sanitize-fixture", manifestPath];
			const stdinContent = JSON.stringify({ body: "collapse me", keep: "as-is" });
			const code = main({ stdinContent });
			expect(code).toBe(0);
			const parsed = JSON.parse(stdoutText()) as Record<string, unknown>;
			expect(parsed.keep).toBe("as-is");
			const marker = parsed.body as Record<string, unknown>;
			expect(marker.sanitized).toBe(true);
			expect(marker.len).toBe("collapse me".length);
		});

		it("re-throws unexpected (non-SanitizeExit) errors so the wrapper maps them to exit 1", () => {
			// The main() try/catch checks `err instanceof SanitizeExit` and
			// re-throws anything else. We drive that branch by making
			// process.stdout.write throw at the pipeline-emit site — a real
			// production runtime never sees this, but the guard against non-
			// SanitizeExit throws is a live safety net worth exercising.
			const manifestPath = join(scratch, "manifest.json");
			writeFileSync(manifestPath, "{}");
			process.argv = ["node", "sanitize-fixture", manifestPath];
			stdoutSpy.mockImplementation(() => {
				throw new Error("stdout blew up");
			});
			expect(() => main({ stdinContent: "input" })).toThrow("stdout blew up");
		});
	});
});
