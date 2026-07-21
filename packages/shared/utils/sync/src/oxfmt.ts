/**
 * Normalise text through the repo's oxfmt formatter (via `bin/mise`), so vendored
 * / generated files match what `qa:format` expects — no sync/format write-loop.
 * Shared by the sync scripts (`schemas.ts` normalises fetched schemas; `turbo.ts`
 * normalises the generated `turbo.json`).
 *
 * @module
 */

import { miseExec } from "@foundation/core";

// Pipe `input` through `oxfmt --stdin-filepath <filepath>` (the filepath tells
// oxfmt which language/formatter to apply) and return the formatted stdout.
// Throws with oxfmt's stderr on a non-zero exit, so a broken formatter aborts
// loudly rather than vendoring un-normalised text.
export function oxfmtText(input: string, filepath: string): string {
	const res = miseExec(["oxfmt", "--stdin-filepath", filepath], { input });
	if (res.status !== 0) {
		throw new Error(`oxfmt failed: ${res.stderr}`);
	}
	return res.stdout;
}
