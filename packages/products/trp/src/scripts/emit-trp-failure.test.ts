// Behaviour tests for `emit-trp-failure.ts` (TRP-O REVISE-loop failure payload).
//
// WHY it matters: this port is a byte-for-byte re-implementation of the Python
// source at `security-pocs/repos/trp/scripts/emit-trp-failure.py`. The main-
// context REVISE loop treats `trp-fail-<task>-a<N>.json` as its `previous_attempt`
// context, so every field name, ordering, tail-extraction bound, and the "bundle
// missing" fallback have to hold — a stderr_tail that drops the failing command,
// or a bundle_missing flag that lies, poisons the next revise round.
//
// `main()` reads files and env vars only. The impl imports no `@foundation/shell`
// helpers and no `fetch` — a per-test scratch directory is enough.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./emit-trp-failure.ts";

// Env vars main() requires; unset & restored around every case.
const REQUIRED_ENV = [
	"LOG_PATH",
	"BUNDLE_JSON",
	"OUT_PATH",
	"STAGE_LABEL",
	"FAILING_CMD",
	"ATTEMPT",
] as const;

describe("emit-trp-failure main()", () => {
	let scratch: string;
	let logPath: string;
	let bundlePath: string;
	let outPath: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "emit-trp-failure-"));
		logPath = join(scratch, "run.log");
		bundlePath = join(scratch, "bundle.json");
		outPath = join(scratch, "trp-fail.json");

		// Wipe any inherited env so a caller's real vars can't leak into the tests.
		for (const key of REQUIRED_ENV) {
			Reflect.deleteProperty(process.env, key);
		}

		process.env.LOG_PATH = logPath;
		process.env.BUNDLE_JSON = bundlePath;
		process.env.OUT_PATH = outPath;
		process.env.STAGE_LABEL = "stage-6-ci";
		process.env.FAILING_CMD = "pnpm run lint";
		process.env.ATTEMPT = "2";
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	// ---- required-env validation --------------------------------------------

	it.each(REQUIRED_ENV)("throws with the offending var name when %s is unset", async (key) => {
		Reflect.deleteProperty(process.env, key);
		await expect(main()).rejects.toThrow(key);
	});

	// ---- tail extraction ----------------------------------------------------

	it("extracts tail from failing command marker with '[ci]' through the next FAIL:", async () => {
		writeFileSync(
			logPath,
			[
				"prelude line 1",
				"prelude line 2",
				"[ci] running pnpm run lint",
				"lint output row A",
				"lint output row B",
				"FAIL: lint",
				"trailing noise 1",
			].join("\n"),
		);
		writeFileSync(bundlePath, JSON.stringify({ files_to_modify: [] }));

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		// end anchors on the FAIL: line, tail slice is [tail_start, end + 1].
		expect(payload.ci_failure.stderr_tail).toBe(
			[
				"prelude line 1",
				"prelude line 2",
				"[ci] running pnpm run lint",
				"lint output row A",
				"lint output row B",
				"FAIL: lint",
			].join("\n"),
		);
	});

	it("uses BLOCKER as both the start marker and the end marker", async () => {
		process.env.FAILING_CMD = "tsc --noEmit";
		writeFileSync(
			logPath,
			[
				"noise A",
				"BLOCKER: tsc --noEmit exited 1",
				"type errors row 1",
				"BLOCKER: rerun refused",
				"noise B",
			].join("\n"),
		);
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.ci_failure.stderr_tail).toBe(
			[
				"noise A",
				"BLOCKER: tsc --noEmit exited 1",
				"type errors row 1",
				"BLOCKER: rerun refused",
			].join("\n"),
		);
	});

	it("falls back to the whole log when no FAIL:/BLOCKER follows the start marker", async () => {
		writeFileSync(logPath, ["row 0", "[ci] pnpm run lint", "row 2", "row 3"].join("\n"));
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		// end === lines.length (4); slice(tail_start, end + 1) covers the entire
		// file, including a trailing empty entry after end.
		expect(payload.ci_failure.stderr_tail).toBe("row 0\n[ci] pnpm run lint\nrow 2\nrow 3");
	});

	it("applies a 150-line tail_start floor when the log is long", async () => {
		const before = Array.from({ length: 300 }, (_, i) => `pre-line-${i}`);
		const lines = [...before, "[ci] pnpm run lint", "middle-1", "middle-2", "FAIL: lint blew up"];
		writeFileSync(logPath, lines.join("\n"));
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		const tailLines = payload.ci_failure.stderr_tail.split("\n");
		// end index of the FAIL: line is 303; tail_start = max(0, 303 - 150) = 153.
		// Slice is [153, 304) → 151 lines.
		expect(tailLines.length).toBe(151);
		expect(tailLines[0]).toBe("pre-line-153");
		expect(tailLines.at(-1)).toBe("FAIL: lint blew up");
	});

	it("floors tail_start at 0 when end - 150 would be negative", async () => {
		writeFileSync(logPath, ["first", "[ci] pnpm run lint", "FAIL: nope"].join("\n"));
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.ci_failure.stderr_tail).toBe("first\n[ci] pnpm run lint\nFAIL: nope");
	});

	it("does not set 'start' when the failing command appears without [ci]/BLOCKER context", async () => {
		process.env.FAILING_CMD = "pnpm run lint";
		writeFileSync(
			logPath,
			["pnpm run lint  # bare mention, no marker", "row A", "FAIL: something else", "row C"].join(
				"\n",
			),
		);
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		// start never set → end stays null → end := lines.length; tail covers all.
		expect(payload.ci_failure.stderr_tail).toBe(
			"pnpm run lint  # bare mention, no marker\nrow A\nFAIL: something else\nrow C",
		);
	});

	it("respects the `i > start` guard: FAIL: on the start line does not close the range", async () => {
		writeFileSync(
			logPath,
			["row 0", "[ci] pnpm run lint FAIL: same-line", "row 2", "FAIL: real end", "row 4"].join(
				"\n",
			),
		);
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		// end must anchor on line 3, not line 1.
		expect(payload.ci_failure.stderr_tail).toBe(
			"row 0\n[ci] pnpm run lint FAIL: same-line\nrow 2\nFAIL: real end",
		);
	});

	// ---- bundle handling ----------------------------------------------------

	it("marks bundle_missing=true and prior_bundle={} when BUNDLE_JSON does not exist", async () => {
		writeFileSync(logPath, "[ci] pnpm run lint\nFAIL: x\n");
		// BUNDLE_JSON path is never created.

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.bundle_missing).toBe(true);
		expect(payload.prior_bundle).toEqual({});
		expect(payload.style_recon).toBeNull();
	});

	it("loads the bundle verbatim into prior_bundle when it exists", async () => {
		writeFileSync(logPath, "[ci] pnpm run lint\nFAIL: x\n");
		const bundle = {
			files_to_modify: [{ path: "a.ts", full_content: "export {}" }],
			style_recon: { conventions: ["kebab-case commits"] },
			extra: "keep me",
		};
		writeFileSync(bundlePath, JSON.stringify(bundle));

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.bundle_missing).toBe(false);
		expect(payload.prior_bundle).toEqual(bundle);
		expect(payload.style_recon).toEqual(bundle.style_recon);
	});

	it("copies style_recon out of the bundle onto the payload when present", async () => {
		writeFileSync(logPath, "");
		writeFileSync(bundlePath, JSON.stringify({ style_recon: "sample-value", other: 1 }));

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.style_recon).toBe("sample-value");
	});

	it("defaults style_recon to null when the bundle has no such key", async () => {
		writeFileSync(logPath, "");
		writeFileSync(bundlePath, JSON.stringify({ files_to_modify: [] }));

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.style_recon).toBeNull();
	});

	it("strips C0 control chars from the bundle (Python json strict=False parity)", async () => {
		writeFileSync(logPath, "");
		// Embed a raw NUL and a raw 0x01 inside a JSON string — Node would reject
		// this normally. The impl's relaxJsonControlChars() drops them so the
		// value on disk still parses, matching Python's `json.loads(..., strict=False)`.
		const rawBytes = Buffer.from('{"style_recon":"clean\u0000\u0001value","kept_tab":"a\\tb"}');
		writeFileSync(bundlePath, rawBytes);

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.prior_bundle).toEqual({
			style_recon: "cleanvalue",
			kept_tab: "a\tb",
		});
		expect(payload.style_recon).toBe("cleanvalue");
	});

	// ---- payload shape ------------------------------------------------------

	it("parses ATTEMPT as a base-10 integer into attempt_number", async () => {
		process.env.ATTEMPT = "07";
		writeFileSync(logPath, "");
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.attempt_number).toBe(7);
	});

	it("preserves stage_label and reflects it in ci_failure.stage", async () => {
		process.env.STAGE_LABEL = "stage-7b-docker-attack";
		writeFileSync(logPath, "");
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.stage_label).toBe("stage-7b-docker-attack");
		expect(payload.ci_failure.stage).toBe("stage-7b-docker-attack");
	});

	it("hard-codes ci_failure.exit_code=1 and command=$FAILING_CMD", async () => {
		process.env.FAILING_CMD = "pnpm --filter web run build";
		writeFileSync(logPath, "");
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.ci_failure.exit_code).toBe(1);
		expect(payload.ci_failure.command).toBe("pnpm --filter web run build");
	});

	it("writes the payload as pretty-printed JSON (tab indent, Python parity) at OUT_PATH", async () => {
		writeFileSync(logPath, "[ci] pnpm run lint\nFAIL: nope\n");
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		expect(existsSync(outPath)).toBe(true);
		const raw = readFileSync(outPath, "utf8");
		// Pretty-print produces a leading brace, then a 2-space-indented line.
		expect(raw.startsWith("{\n  ")).toBe(true);
		// And round-trips into a stable object.
		expect(() => JSON.parse(raw)).not.toThrow();
	});

	it("prints the '   wrote <out_path> (<size> bytes)' summary line to stdout", async () => {
		writeFileSync(logPath, "");
		writeFileSync(bundlePath, "{}");

		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});
		await expect(main()).resolves.toBe(0);

		const stdout = chunks.join("");
		expect(stdout).toMatch(
			new RegExp(
				`^   wrote ${outPath.replaceAll(/[/.]/gu, String.raw`\$&`)} \\(\\d+ bytes\\)\n$`,
				"u",
			),
		);
	});

	// ---- integration --------------------------------------------------------

	it("end-to-end: writes every payload field for a realistic failure fixture", async () => {
		process.env.ATTEMPT = "3";
		process.env.STAGE_LABEL = "stage-6-ci";
		process.env.FAILING_CMD = "pnpm run test";
		writeFileSync(
			logPath,
			[
				"[trp] applying bundle...",
				"[trp] bundle applied cleanly",
				"[ci] running pnpm run test",
				"  vitest run --reporter=verbose",
				"  ✓ src/foo.test.ts (12)",
				"  ✗ src/bar.test.ts (1 failing)",
				"FAIL: pnpm run test",
				"[trp] teardown",
			].join("\n"),
		);
		const bundle = {
			task_id: "TASK-99",
			files_to_modify: [{ path: "src/bar.ts", full_content: "export const bar = 1;" }],
			style_recon: { indent: "tab", quote: "double" },
		};
		writeFileSync(bundlePath, JSON.stringify(bundle));

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload).toEqual({
			attempt_number: 3,
			stage_label: "stage-6-ci",
			prior_bundle: bundle,
			bundle_missing: false,
			ci_failure: {
				command: "pnpm run test",
				exit_code: 1,
				stage: "stage-6-ci",
				stderr_tail: [
					"[trp] applying bundle...",
					"[trp] bundle applied cleanly",
					"[ci] running pnpm run test",
					"  vitest run --reporter=verbose",
					"  ✓ src/foo.test.ts (12)",
					"  ✗ src/bar.test.ts (1 failing)",
					"FAIL: pnpm run test",
				].join("\n"),
			},
			style_recon: { indent: "tab", quote: "double" },
		});
	});

	// ---- splitlines parity edge cases ---------------------------------------

	it("handles CRLF line endings the way Python str.splitlines() does", async () => {
		writeFileSync(logPath, "row A\r\n[ci] pnpm run lint\r\nrow B\r\nFAIL: nope\r\n");
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.ci_failure.stderr_tail).toBe("row A\n[ci] pnpm run lint\nrow B\nFAIL: nope");
	});

	it("handles an empty log file without throwing", async () => {
		writeFileSync(logPath, "");
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		expect(payload.ci_failure.stderr_tail).toBe("");
	});

	it("drops the terminal-newline empty tail entry (splitlines parity)", async () => {
		writeFileSync(logPath, "[ci] pnpm run lint\nFAIL: nope\n");
		writeFileSync(bundlePath, "{}");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);

		const payload = JSON.parse(readFileSync(outPath, "utf8"));
		// Python splitlines drops the trailing empty. Tail must NOT end with "\n".
		expect(payload.ci_failure.stderr_tail.endsWith("nope")).toBe(true);
	});
});
