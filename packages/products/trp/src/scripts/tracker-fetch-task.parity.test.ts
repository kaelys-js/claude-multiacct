// Parity test for `tracker-fetch-task.ts` against the Python original
// `trp/scripts/tracker-fetch-task.py`. Both scripts read a mock ClickUp
// payload (task / comments / attachments), normalise it to the stable
// TRP task record, and write it to `<out-dir>/task-<slug>.json` so
// downstream stages (design, patch, verify) see the same fields
// regardless of tracker.
//
// WHY it matters: the design + patch stages read this JSON file as the
// authoritative task context. Field ordering, the description-fallback
// chain (`text_content` -> `description`), the `_raw` passthrough shape,
// and the array projections for assignees / comments / attachments each
// feed different downstream prompts. A drift in any of them silently
// corrupts the workflow's understanding of the finding. The Python
// original is the contract every downstream stage was built against;
// this test pins the TS port to the same bytes.
//
// Output shape: (c) filesystem write to `<out-dir>/task-<slug>.json`.
// Stdout carries the written path as a one-line log, but the driver
// consumes the file — the path bytes are absolute and would force
// sanitization for no reader benefit, so stdout is not oracle-compared.
//
// Comparator: byte-for-byte equality between the file the TS port
// writes at `<tmp-out>/task-test-1.json` and `expected.json` (captured
// from a subprocess invocation of the Python original against the same
// `input.json` mock). Both `json.dumps(record, indent=2, sort_keys=False)`
// (Python) and `JSON.stringify(record, null, 2)` (Node) produce
// identical bytes for this ASCII payload — indent=2, no key sorting,
// matching separator conventions, single trailing newline.
//
// Fixture: `tests/fixtures/scripts/tracker-fetch-task/input.json` is a
// hand-authored ClickUp mock exercising the branches the normaliser
// cares about — `text_content` present (wins over `description`),
// `status` / `priority` as objects, two assignees, a comment with a
// null user (the `.user || {}` fallback), custom fields, subtasks.
// No client source, no secrets, no absolute paths in content —
// sanitize-manifest.json records zero replacements.
//
// Failure diagnostic (Rule 12): on mismatch, prints both actual and
// expected bytes so a driver-log reader sees exactly which byte
// drifted without cross-referencing the expected file by hand.

/* oxlint-disable vitest/no-conditional-in-test */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./tracker-fetch-task.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"tracker-fetch-task",
);

const TASK_ID = "TEST-1";
const SLUG = "test-1";

// The Python original writes to `<out-dir>/task-<slug>.json`. The TS
// port does the same. To keep the test hermetic we point --out-dir at
// a per-case tempdir so a stray write can never corrupt sibling tests
// or the checked-in fixture tree, and we cleanly restore any env vars
// the script inspects (TRP_MOCK / TRP_MOCK_FIXTURE / TRACKER_TYPE /
// CLICKUP_TOKEN_FILE) so ordering-dependent tests stay honest.
describe("tracker-fetch-task.ts — parity against Python original", () => {
	let tempDir: string;
	const savedEnv = {
		TRACKER_TYPE: process.env["TRACKER_TYPE"],
		TRP_MOCK: process.env["TRP_MOCK"],
		TRP_MOCK_FIXTURE: process.env["TRP_MOCK_FIXTURE"],
		CLICKUP_TOKEN_FILE: process.env["CLICKUP_TOKEN_FILE"],
		CLICKUP_TEAM_ID: process.env["CLICKUP_TEAM_ID"],
		TRP_ALLOW_FALLBACK_TOKEN: process.env["TRP_ALLOW_FALLBACK_TOKEN"],
		TRP_FALLBACK_TOKEN_DIR: process.env["TRP_FALLBACK_TOKEN_DIR"],
	};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "tracker-fetch-task-parity-"));
		mkdirSync(tempDir, { recursive: true });
		// The mock branch short-circuits token loading and the API call,
		// so nothing here should ever touch the network. Explicitly clear
		// env vars that would otherwise flip the code path.
		delete process.env["TRACKER_TYPE"];
		delete process.env["TRP_MOCK"];
		delete process.env["TRP_MOCK_FIXTURE"];
		delete process.env["CLICKUP_TOKEN_FILE"];
		delete process.env["CLICKUP_TEAM_ID"];
		delete process.env["TRP_ALLOW_FALLBACK_TOKEN"];
		delete process.env["TRP_FALLBACK_TOKEN_DIR"];
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

	it("writes the normalised task JSON byte-for-byte", async () => {
		const mockPath = join(FIXTURE_DIR, "input.json");
		const expectedBytes = readFileSync(join(FIXTURE_DIR, "expected.json"), "utf8");

		await main(["--task", `clickup:${TASK_ID}`, "--mock", mockPath, "--out-dir", tempDir]);

		const actualBytes = readFileSync(join(tempDir, `task-${SLUG}.json`), "utf8");

		if (actualBytes !== expectedBytes) {
			// Rule 12: fail loud. Print both sides so a CI reader sees
			// exactly which byte drifted without re-running locally.
			// eslint-disable-next-line no-console
			console.error(
				`[parity:tracker-fetch-task] actual=\n${actualBytes}\nexpected=\n${expectedBytes}`,
			);
		}
		expect(actualBytes).toBe(expectedBytes);
	});
});
