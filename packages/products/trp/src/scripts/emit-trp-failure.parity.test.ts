// Parity test for `emit-trp-failure.ts` against the Python original
// `trp/scripts/emit-trp-failure.py`. Both scripts read a log at
// $LOG_PATH and a bundle at $BUNDLE_JSON, walk the log to extract the
// tail around the failing command, and write a structured failure
// payload to $OUT_PATH for the SRP-J / TRP-O revise loop.
//
// WHY it matters: main context reads the side-effect JSON verbatim to
// build the workflow's `previous_attempt` REVISE arg. A drift in field
// ordering, the stderr-tail window (the ±150-line slice around the
// failing command), or the `style_recon` passthrough silently corrupts
// the revise input — the fix loop regresses or stalls without any
// surfaced error. The Python original is the contract the loop was
// built against; this test pins the TS port to the same bytes.
//
// Output shape: (d) side-effect JSON file written to $OUT_PATH. Stdout
// carries a one-line "wrote <path> (<size> bytes)" log entry, but the
// driver only consumes the JSON — we assert exit code and file bytes
// only. The stdout wording is not part of the driver contract and is
// deliberately not oracle-compared (path bytes would leak into the
// fixture and force sanitization for no reader benefit).
//
// Comparator: byte-for-byte equality between the file the TS port
// writes at $OUT_PATH and `expected-side.json` (captured from a
// subprocess invocation of the Python original against the same
// `input.json` + `input.log`). Both `json.dumps(payload, indent=2)`
// (Python) and `JSON.stringify(payload, null, 2)` (Node) produce
// identical bytes for this schema — no key sorting, no trailing
// newline, matching indent + separator conventions.
//
// Fixture: `tests/fixtures/scripts/emit-trp-failure/input.json` is a
// minimal bundle carrying `files_to_modify` + a `style_recon`
// passthrough field; `input.log` is a hand-authored 9-line trace that
// triggers both the start-marker branch (`[ci]` + failing command)
// and the end-marker branch (`FAIL:` line after start). No client
// source, no secrets, no absolute paths — sanitize-manifest.json
// records zero replacements.
//
// Failure diagnostic (Rule 12): on mismatch, prints both actual and
// expected bytes so a driver-log reader sees exactly which byte
// drifted without cross-referencing the expected file by hand.

/* oxlint-disable vitest/no-conditional-in-test */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./emit-trp-failure.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"emit-trp-failure",
);

const STAGE_LABEL = "stage-f-cheap";
const FAILING_CMD = "pnpm run test";
const ATTEMPT = "2";

// The Python original reads BUNDLE_JSON / LOG_PATH by whatever string
// they contain (absolute or relative) and writes OUT_PATH the same way.
// To keep the test hermetic, we copy the fixture bundle + log into a
// per-case tempdir and point each env var at those copies — no writes
// touch the checked-in fixture tree. The output JSON also lands in the
// tempdir so a stray write can never corrupt sibling tests.
describe("emit-trp-failure.ts — parity against Python original", () => {
	let tempDir: string;
	const savedEnv = {
		BUNDLE_JSON: process.env["BUNDLE_JSON"],
		LOG_PATH: process.env["LOG_PATH"],
		OUT_PATH: process.env["OUT_PATH"],
		STAGE_LABEL: process.env["STAGE_LABEL"],
		FAILING_CMD: process.env["FAILING_CMD"],
		ATTEMPT: process.env["ATTEMPT"],
	};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "emit-trp-failure-parity-"));
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = v;
			}
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes the recorded side-effect JSON byte-for-byte", async () => {
		const bundleSrc = readFileSync(join(FIXTURE_DIR, "input.json"), "utf8");
		const logSrc = readFileSync(join(FIXTURE_DIR, "input.log"), "utf8");
		const expectedBytes = readFileSync(join(FIXTURE_DIR, "expected-side.json"), "utf8");

		const bundlePath = join(tempDir, "bundle.json");
		const logPath = join(tempDir, "input.log");
		const outPath = join(tempDir, "out.json");
		writeFileSync(bundlePath, bundleSrc);
		writeFileSync(logPath, logSrc);

		process.env["BUNDLE_JSON"] = bundlePath;
		process.env["LOG_PATH"] = logPath;
		process.env["OUT_PATH"] = outPath;
		process.env["STAGE_LABEL"] = STAGE_LABEL;
		process.env["FAILING_CMD"] = FAILING_CMD;
		process.env["ATTEMPT"] = ATTEMPT;

		const code = await main();
		expect(code).toBe(0);

		const actualBytes = readFileSync(outPath, "utf8");

		if (actualBytes !== expectedBytes) {
			// Rule 12: fail loud. Print both sides so a CI reader sees
			// exactly which byte drifted without re-running locally.
			// eslint-disable-next-line no-console
			console.error(
				`[parity:emit-trp-failure] actual=\n${actualBytes}\nexpected=\n${expectedBytes}`,
			);
		}
		expect(actualBytes).toBe(expectedBytes);
	});
});
