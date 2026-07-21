#!/usr/bin/env node
/**
 * `emit-trp-failure.ts` — TRP-O helper, TS port of `trp/scripts/emit-trp-failure.py`.
 *
 * Emits `trp-fail-<task>-a<N>.json` for the main-context REVISE loop.
 *
 * Env vars: `BUNDLE_JSON`, `LOG_PATH`, `OUT_PATH`, `STAGE_LABEL`, `FAILING_CMD`,
 * `ATTEMPT`. Extracts the last ~120 lines around the failing command from
 * `LOG_PATH` and writes a structured payload that the workflow's REVISE mode
 * consumes as `previous_attempt`.
 *
 * Migrated byte-for-byte from the Python source — every branch, every field
 * ordering, and the stdout summary line are preserved verbatim.
 *
 * @module
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";

export type EmitTrpFailurePayload = {
	attempt_number: number;
	stage_label: string;
	prior_bundle: Record<string, unknown>;
	bundle_missing: boolean;
	ci_failure: {
		command: string;
		exit_code: number;
		stage: string;
		stderr_tail: string;
	};
	style_recon: unknown;
};

export async function main(): Promise<number> {
	await Promise.resolve();
	const logPath = process.env.LOG_PATH;
	const bundlePath = process.env.BUNDLE_JSON;
	const outPath = process.env.OUT_PATH;
	const stageLabel = process.env.STAGE_LABEL;
	const failingCmd = process.env.FAILING_CMD;
	const attemptRaw = process.env.ATTEMPT;

	if (logPath === undefined) {
		throw new Error("LOG_PATH");
	}
	if (bundlePath === undefined) {
		throw new Error("BUNDLE_JSON");
	}
	if (outPath === undefined) {
		throw new Error("OUT_PATH");
	}
	if (stageLabel === undefined) {
		throw new Error("STAGE_LABEL");
	}
	if (failingCmd === undefined) {
		throw new Error("FAILING_CMD");
	}
	if (attemptRaw === undefined) {
		throw new Error("ATTEMPT");
	}

	const attempt = Math.trunc(Number(attemptRaw));

	// Python: pathlib.Path(log_path).read_text(errors='replace').splitlines()
	// Node equivalent: read as UTF-8 with replacement, then splitlines-compatible split.
	const rawLog = readFileSync(logPath);
	const logText = rawLog.toString("utf8");
	const lines = splitlines(logText);

	let start: number | null = null;
	let end: number | null = null;
	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		if (ln === undefined) {
			throw new Error("unexpected undefined");
		}
		if (
			failingCmd &&
			ln.includes(failingCmd) &&
			(ln.includes("[ci]") || ln.includes("BLOCKER")) &&
			start === null
		) {
			start = i;
		}
		if (start !== null && (ln.includes("FAIL:") || ln.includes("BLOCKER")) && i > start) {
			end = i;
		}
	}
	if (end === null) {
		end = lines.length;
	}
	const tailStart = Math.max(0, (end ?? 0) - 150);
	const tail = lines.slice(tailStart, end + 1).join("\n");

	let bundle: Record<string, unknown>;
	let bundleMissing: boolean;
	if (existsSync(bundlePath)) {
		// Python: json.loads(..., strict=False) — strict=False permits control chars in strings.
		// Node's JSON.parse is already lenient about control chars? No: it rejects unescaped
		// control chars in strings. Match the Python behaviour by stripping raw control chars
		// from the input before parsing so a log-embedded bundle still loads.
		const bundleText = readFileSync(bundlePath, "utf8");
		bundle = JSON.parse(relaxJsonControlChars(bundleText)) as Record<string, unknown>;
		bundleMissing = false;
	} else {
		bundle = {};
		bundleMissing = true;
	}

	const payload: EmitTrpFailurePayload = {
		attempt_number: attempt,
		stage_label: stageLabel,
		prior_bundle: bundle,
		bundle_missing: bundleMissing,
		ci_failure: {
			command: failingCmd,
			exit_code: 1,
			stage: stageLabel,
			stderr_tail: tail,
		},
		style_recon: (bundle as { style_recon?: unknown }).style_recon ?? null,
	};

	writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
	const { size } = statSync(outPath);
	process.stdout.write(`   wrote ${outPath} (${size} bytes)\n`);
	return 0;
}

// Mirror of Python's str.splitlines() — splits on \n, \r, \r\n; trailing empty
// entry after a terminal newline is dropped.
function splitlines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	const parts = text.split(/\r\n|\r|\n/u);
	if (parts.length > 0 && parts.at(-1) === "" && /[\r\n]$/u.test(text)) {
		parts.pop();
	}
	return parts;
}

// Python json with strict=False allows raw control chars (0x00-0x1f except the
// standard whitespace set) inside string tokens. Node's JSON.parse rejects
// them. Strip the offending bytes so a bundle that a shell redirected through
// binary-tainted output still parses.
function relaxJsonControlChars(text: string): string {
	// Keep TAB (0x09), LF (0x0a), CR (0x0d); drop other C0 controls.
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const isDroppedControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d;
		if (!isDroppedControl) {
			out += ch;
		}
	}
	return out;
}

function isDirectRun(): boolean {
	const [, entry] = process.argv;
	if (!entry) {
		return false;
	}
	try {
		return realpathSync(import.meta.filename) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		const code = await main();
		process.exit(code);
	} catch (error: unknown) {
		process.stderr.write(`emit-trp-failure: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
