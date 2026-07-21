#!/usr/bin/env node
/**
 * `tracker-post-proof.ts` — TS port of `trp/scripts/tracker-post-proof.py`.
 *
 * Post proof artefacts to the task tracker with a status transition.
 *
 * Polymorphic poster: same entry point regardless of tracker backend. Refuses
 * by default -- remote mutation only happens when `TRP_ALLOW_REMOTE_MUTATE` is
 * explicitly set to `'true'`. Child-task creation is behind an additional
 * sub-gate (`TRP_ALLOW_CHILD_TICKET_CREATE`) because a mis-fire spawns tracker
 * noise a plain comment can't.
 *
 * ClickUp posting is implemented for `--action=comment`: reads the drafted
 * comment payload from `<proof-dir>/comment-payload.json` (built by the driver
 * `[SW]` stage), converts the writeup markdown to ClickUp comment blocks so
 * headers, bullets, and bold render properly in the tracker UI, then POSTs
 * via the v2 API. Applies the status transition afterward. Marks the payload
 * `posted:true` on success for idempotency.
 *
 * Ported byte-for-byte from the Python source — every branch, every regex,
 * every stdout / stderr line, every exit code is preserved verbatim. No
 * feature additions.
 *
 * Env config (with defaults from srp.env / trp.env):
 *   `CLICKUP_TOKEN_FILE`  path to token file (default: `.env.clickup`)
 *   `CLICKUP_TEAM_ID`     workspace id (default: `8593845`)
 *
 * Exit codes:
 *   0  posted (or dry-run plan printed)
 *   2  bad arguments
 *   3  refused: `TRP_ALLOW_REMOTE_MUTATE` (or child-ticket sub-gate) not set
 *   4  network / API error
 *
 * @module
 */

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { pyOr, pyRound } from "./pyshim.ts";

const ACTIONS = ["comment", "attachment", "create-child-task"] as const;
type Action = (typeof ACTIONS)[number];

const CLICKUP_API = "https://api.clickup.com/api/v2";

type ParsedArgs = {
	task: string;
	action: Action;
	dry_run: boolean;
	proof_dir?: string;
	status_transition: string;
	attach_file?: string;
	child_title?: string;
	child_description: string;
	child_priority: string;
	child_list_id?: string;
};

type CommentBlock = {
	text: string;
	attributes?: Record<string, unknown>;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function rglobFiles(root: string): string[] {
	// Mirrors pathlib.Path.rglob('*') filtered by is_file(), sorted.
	const results: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				st = undefined;
			}
			if (st?.isDirectory()) {
				walk(full);
			} else if (st?.isFile()) {
				results.push(full);
			}
		}
	};
	walk(root);
	results.sort();
	return results;
}

// ---------------------------------------------------------------------------
// Plan printers
// ---------------------------------------------------------------------------

export function collectArtefacts(proofDir: string): string[] {
	if (!isDir(proofDir)) {
		process.stderr.write(`proof-dir does not exist or is not a directory: ${proofDir}\n`);
		process.exit(2);
	}
	return rglobFiles(proofDir);
}

export function printCommentPlan(
	task: string,
	artefacts: string[],
	statusTransition: string,
	dryRun: boolean,
	proofDir: string | null = null,
): void {
	const header = dryRun ? "DRY-RUN" : "STUB (network call not implemented)";
	process.stdout.write(`[${header}] would post proof COMMENT to task ${task}\n`);
	process.stdout.write(`  status transition: ${statusTransition}\n`);
	process.stdout.write(`  artefacts (${artefacts.length}):\n`);
	for (const a of artefacts) {
		process.stdout.write(`    - ${a}\n`);
	}
	process.stdout.write(
		`  comment body (first line): "Proof bundle attached for ${task} -- ${artefacts.length} files"\n`,
	);
	if (proofDir !== null) {
		const suffix = speedupSuffix(proofDir);
		if (suffix) {
			for (const line of suffix.trim().split("\n")) {
				process.stdout.write(`  ${line}\n`);
			}
		}
	}
}

export function printAttachmentPlan(task: string, attachFile: string, dryRun: boolean): void {
	const header = dryRun ? "DRY-RUN" : "STUB (network call not implemented)";
	const { size } = statSync(attachFile);
	process.stdout.write(`[${header}] would post ATTACHMENT to task ${task}\n`);
	process.stdout.write(`  file: ${attachFile}\n`);
	process.stdout.write(`  size: ${size} bytes\n`);
}

export function printChildTaskPlan(
	task: string,
	title: string,
	description: string,
	priority: string,
	listId: string,
	dryRun: boolean,
): void {
	const header = dryRun ? "DRY-RUN" : "STUB (network call not implemented)";
	process.stdout.write(`[${header}] would CREATE CHILD TASK linked to ${task}\n`);
	process.stdout.write(`  target list: ${listId}\n`);
	process.stdout.write(`  title: ${title}\n`);
	process.stdout.write(`  priority: ${priority}\n`);
	const firstLine = description ? (description.split("\n")[0] ?? "") : "";
	process.stdout.write(`  description (first line): ${firstLine}\n`);
	process.stdout.write(
		`  link relation: linked-task custom field -> parent ${task} (fallback: plain sub-task if workspace lacks the custom field)\n`,
	);
}

// ---------------------------------------------------------------------------
// Argument parsing (minimal argparse equivalent)
// ---------------------------------------------------------------------------

function die(msg: string): never {
	process.stderr.write(`${msg}\n`);
	process.exit(2);
}

function takeValue(argv: string[], i: number, name: string): string {
	const v = argv[i + 1];
	if (v === undefined || v.startsWith("--")) {
		die(`argument ${name}: expected one argument`);
	}
	return v as string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = {
		task: "",
		action: "comment",
		dry_run: false,
		status_transition: "in review",
		child_description: "",
		child_priority: "normal",
	};
	let seenTask = false;

	let i = 0;
	while (i < argv.length) {
		const a = argv[i];
		if (a === undefined) {
			break;
		}
		if (a === "--task") {
			out.task = takeValue(argv, i, "--task");
			seenTask = true;
			i += 2;
		} else if (a === "--action") {
			const v = takeValue(argv, i, "--action");
			if (!(ACTIONS as readonly string[]).includes(v)) {
				die(
					`argument --action: invalid choice: '${v}' (choose from ${ACTIONS.map((x) => `'${x}'`).join(", ")})`,
				);
			}
			out.action = v as Action;
			i += 2;
		} else if (a.startsWith("--action=")) {
			// argparse accepts --action=comment style too.
			const v = a.slice("--action=".length);
			if (!(ACTIONS as readonly string[]).includes(v)) {
				die(
					`argument --action: invalid choice: '${v}' (choose from ${ACTIONS.map((x) => `'${x}'`).join(", ")})`,
				);
			}
			out.action = v as Action;
			i += 1;
		} else if (a === "--dry-run") {
			out.dry_run = true;
			i += 1;
		} else if (a === "--proof-dir") {
			out.proof_dir = takeValue(argv, i, "--proof-dir");
			i += 2;
		} else if (a === "--status-transition") {
			out.status_transition = takeValue(argv, i, "--status-transition");
			i += 2;
		} else if (a === "--attach-file") {
			out.attach_file = takeValue(argv, i, "--attach-file");
			i += 2;
		} else if (a === "--child-title") {
			out.child_title = takeValue(argv, i, "--child-title");
			i += 2;
		} else if (a === "--child-description") {
			out.child_description = takeValue(argv, i, "--child-description");
			i += 2;
		} else if (a === "--child-priority") {
			out.child_priority = takeValue(argv, i, "--child-priority");
			i += 2;
		} else if (a === "--child-list-id") {
			out.child_list_id = takeValue(argv, i, "--child-list-id");
			i += 2;
			// Handle --long=value forms uniformly for the value-taking args.
		} else if (a.startsWith("--") && a.indexOf("=") > 0) {
			const eq = a.indexOf("=");
			const key = a.slice(0, eq);
			const val = a.slice(eq + 1);
			switch (key) {
				case "--task": {
					out.task = val;
					seenTask = true;
					break;
				}
				case "--proof-dir": {
					out.proof_dir = val;
					break;
				}
				case "--status-transition": {
					out.status_transition = val;
					break;
				}
				case "--attach-file": {
					out.attach_file = val;
					break;
				}
				case "--child-title": {
					out.child_title = val;
					break;
				}
				case "--child-description": {
					out.child_description = val;
					break;
				}
				case "--child-priority": {
					out.child_priority = val;
					break;
				}
				case "--child-list-id": {
					out.child_list_id = val;
					break;
				}
				default: {
					die(`unrecognized arguments: ${a}`);
				}
			}
			i += 1;
		} else {
			die(`unrecognized arguments: ${a}`);
		}
	}

	if (!seenTask) {
		die("the following arguments are required: --task");
	}
	return out;
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
	// Guardrail first -- before argparse, before anything. An operator who
	// forgets the flag gets a distinct refusal (exit 3), not an argparse
	// usage error (exit 2) that reads as their own mistake.
	if ((process.env.TRP_ALLOW_REMOTE_MUTATE ?? "false").toLowerCase() !== "true") {
		process.stderr.write("refusing: TRP_ALLOW_REMOTE_MUTATE not set (default safety gate)\n");
		process.exit(3);
	}

	const args = parseArgs(process.argv.slice(2));

	// Sub-gate: creating tracker items is louder than commenting on one
	// that already exists. Distinct env var so an operator can enable
	// comments/attachments without also enabling ticket creation.
	if (
		args.action === "create-child-task" &&
		(process.env.TRP_ALLOW_CHILD_TICKET_CREATE ?? "false").toLowerCase() !== "true"
	) {
		process.stderr.write(
			"refusing: TRP_ALLOW_CHILD_TICKET_CREATE not set (child-ticket sub-gate; comments/attachments are allowed under TRP_ALLOW_REMOTE_MUTATE, ticket creation needs this too)\n",
		);
		process.exit(3);
	}

	if (args.action === "comment") {
		if (!args.proof_dir) {
			process.stderr.write("--proof-dir is required for --action=comment\n");
			process.exit(2);
		}
		if (args.dry_run) {
			const artefacts = collectArtefacts(args.proof_dir);
			printCommentPlan(args.task, artefacts, args.status_transition, true, args.proof_dir);
		}
	} else if (args.action === "attachment") {
		if (!args.attach_file) {
			process.stderr.write("--attach-file is required for --action=attachment\n");
			process.exit(2);
		}
		if (!isFile(args.attach_file)) {
			process.stderr.write(`attach-file does not exist or is not a file: ${args.attach_file}\n`);
			process.exit(2);
		}
		printAttachmentPlan(args.task, args.attach_file, args.dry_run);
	} else if (args.action === "create-child-task") {
		if (!args.child_title || !args.child_list_id) {
			process.stderr.write(
				"--child-title and --child-list-id are required for --action=create-child-task\n",
			);
			process.exit(2);
		}
		printChildTaskPlan(
			args.task,
			args.child_title,
			args.child_description,
			args.child_priority,
			args.child_list_id,
			args.dry_run,
		);
	}

	if (args.dry_run) {
		return 0;
	}

	// Live path: only comment posting is wired. attachment / create-child-task
	// still print-plan-only until their API contracts land.
	if (args.action === "comment") {
		const proofDir = args.proof_dir;
		if (proofDir === undefined) {
			throw new Error("unexpected undefined");
		}
		return await postCommentLive(args.task, proofDir, args.status_transition);
	}
	process.stdout.write("  (network call not implemented for this action; use --dry-run)\n");
	return 0;
}

// ---------------------------------------------------------------------------
// ClickUp token loader
// ---------------------------------------------------------------------------

function loadToken(): string {
	// Read the ClickUp personal token from CLICKUP_TOKEN_FILE (default
	// .env.clickup). Accepts either a bare pk_... line or CLICKUP_TOKEN=... KEY=VALUE.
	const path = process.env.CLICKUP_TOKEN_FILE ?? ".env.clickup";
	if (!isFile(path)) {
		process.stderr.write(
			`ClickUp token file not found: ${path}. Set CLICKUP_TOKEN_FILE or place .env.clickup in the current directory.\n`,
		);
		process.exit(4);
	}
	const raw = readFileSync(path, "utf8");
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.trim();
		if (line && !line.startsWith("#")) {
			if (line.includes("=")) {
				const eq = line.indexOf("=");
				const key = line.slice(0, eq);
				const value = line.slice(eq + 1);
				if (key.trim() === "CLICKUP_TOKEN" || key.trim() === "TOKEN") {
					return value.trim();
				}
			} else if (line.startsWith("pk_")) {
				return line;
			}
		}
	}
	process.stderr.write(
		`no ClickUp token found in ${path} (expected pk_... or CLICKUP_TOKEN=pk_...)\n`,
	);
	process.exit(4);
}

// ---------------------------------------------------------------------------
// Markdown → ClickUp comment blocks
// ---------------------------------------------------------------------------

// Inline markdown patterns, longest-first so ** wins over *. Italic content
// permits embedded underscores because payload text like `_Task: clickup:
// HAND_ITC-308_` is a real case -- the outer underscores are at word-boundary
// and the inner ones are inside an identifier, so it italicises cleanly if
// we accept `.+?` between word-boundary anchors instead of stripping content
// down to `[^_]*?`.
// Groups: 1 = **bold**, 2 = __bold__, 3 = *italic*, 4 = _italic_, 5 = `code`,
// 6 = ~~strike~~, 7 = img alt, 8 = img url, 9 = link text, 10 = link url,
// 11 = autolink.
const INLINE_MD = new RegExp(
	`${
		String.raw`\*\*([^*]+?)\*\*` // 1 bold **x**
	}|__([^_]+?)__${
		// 2 bold __x__
		String.raw`|(?<!\w)\*(?![\s*])(.+?)(?<![\s*])\*(?!\w)` // 3 italic *x*
	}${
		String.raw`|(?<!\w)_(?![\s_])(.+?)(?<![\s_])_(?!\w)` // 4 italic _x_
	}|\`([^\`]+)\`` + // 5 code `x`
		`|~~([^~]+?)~~${
			// 6 strike ~~x~~
			String.raw`|!\[([^\]]*)\]\(([^)\s]+)\)` // 7 img alt, 8 url
		}${
			String.raw`|(?<!!)\[([^\]]+)\]\(([^)\s]+)\)` // 9 link text, 10 url
		}${String.raw`|<(https?://[^>\s]+)>`}`, // 11 autolink
	"gu",
);

function splitInlineRuns(
	line: string,
	paraAttrs: Record<string, unknown> | null = null,
): CommentBlock[] {
	// Split one line's text into ClickUp comment runs, preserving inline
	// **bold**, _italic_, and `code` markdown as per-run attributes.
	// paraAttrs are structural attributes (header, list) attached to the FIRST
	// run so ClickUp treats the whole paragraph as that block type.
	const runs: CommentBlock[] = [];

	const push = (text: string, extra: Record<string, unknown> | null = null): void => {
		// Python: `if not text: return` — empty string is falsy, returns early.
		if (!text) {
			return;
		}
		const attrs: Record<string, unknown> = {};
		if (runs.length === 0 && paraAttrs) {
			Object.assign(attrs, paraAttrs);
		}
		if (extra) {
			Object.assign(attrs, extra);
		}
		const block: CommentBlock = { text };
		if (Object.keys(attrs).length > 0) {
			block.attributes = attrs;
		}
		runs.push(block);
	};

	let cursor = 0;
	// Reset the RegExp's lastIndex between calls (it's a global regex reused).
	INLINE_MD.lastIndex = 0;
	for (const m of line.matchAll(INLINE_MD)) {
		const start = m.index;
		if (start === undefined) {
			throw new Error("unexpected undefined");
		}
		const end = start + m[0].length;
		if (start > cursor) {
			push(line.slice(cursor, start));
		}
		if (m[1] !== undefined || m[2] !== undefined) {
			push((m[1] ?? m[2]) as string, { bold: true });
		} else if (m[3] !== undefined || m[4] !== undefined) {
			push((m[3] ?? m[4]) as string, { italic: true });
		} else if (m[5] !== undefined) {
			push(m[5], { code: true });
		} else if (m[6] !== undefined) {
			push(m[6], { strike: true });
		} else if (m[7] !== undefined || m[8] !== undefined) {
			// Image -> link fallback: ClickUp comment API doesn't inline
			// images, so we surface the alt text as a link to the image URL.
			const imgUrl = m.at(8);
			if (imgUrl === undefined) {
				throw new Error("unexpected undefined");
			}
			const alt = m[7] || imgUrl;
			push(alt, { link: { url: imgUrl } });
		} else if (m[9] !== undefined) {
			const linkUrl = m.at(10);
			if (linkUrl === undefined) {
				throw new Error("unexpected undefined");
			}
			push(m[9], { link: { url: linkUrl } });
		} else if (m[11] !== undefined) {
			push(m[11], { link: { url: m[11] } });
		}
		cursor = end;
	}
	if (cursor < line.length) {
		push(line.slice(cursor));
	}
	if (runs.length === 0 && paraAttrs) {
		// Empty line with structural attrs -- keep the block so the
		// paragraph type still applies to something.
		// Python: push('', None). `push` returns early on empty text, so this
		// is a no-op — preserved verbatim for parity.
		push("", null);
	}
	return runs;
}

/**
 * Append inline-markdown runs to `blocks`, terminating the last run with a
 * trailing newline. No-op when `runs` is empty (e.g. a blank paragraph).
 *
 * @param {CommentBlock[]} blocks - the accumulator array to push onto
 * @param {CommentBlock[]} runs - the inline runs produced by {@link splitInlineRuns}
 * @returns {void} nothing; mutates `blocks` in place
 */
function pushRunsWithNewline(blocks: CommentBlock[], runs: CommentBlock[]): void {
	if (runs.length === 0) {
		return;
	}
	const last = runs.at(-1);
	if (last === undefined) {
		throw new Error("unexpected undefined");
	}
	last.text = `${last.text}\n`;
	blocks.push(...runs);
}

export function mdToClickupBlocks(mdInput: string): CommentBlock[] {
	// HTML comment strip (silent): remove <!-- ... --> anywhere, incl.
	// multi-line, before the line-scanner sees them.
	const md = mdInput.replaceAll(/<!--[\s\S]*?-->/gu, "");

	const blocks: CommentBlock[] = [];
	const paraLines: string[] = [];
	let inCode = false;
	const codeLines: string[] = [];

	const flushPara = (): void => {
		if (paraLines.length === 0) {
			return;
		}
		// Hard-break support: a source line ending in two-or-more trailing
		// spaces becomes a literal '\n' inside the joined paragraph text so
		// splitInlineRuns preserves the break inside its run.
		const segments: Array<[string, boolean]> = [];
		for (const l of paraLines) {
			const s = l.trim();
			if (s) {
				const rstripped = l.replace(/\n+$/u, "");
				const hard = / {2,}$/u.test(rstripped);
				segments.push([s, hard]);
			}
		}
		if (segments.length > 0) {
			const parts: string[] = [];
			for (let idx = 0; idx < segments.length; idx++) {
				if (idx > 0) {
					const prev = segments[idx - 1];
					if (prev === undefined) {
						throw new Error("unexpected undefined");
					}
					parts.push(prev[1] ? "\n" : " ");
				}
				const seg = segments[idx];
				if (seg === undefined) {
					throw new Error("unexpected undefined");
				}
				parts.push(seg[0]);
			}
			const text = parts.join("");
			const runs = splitInlineRuns(text);
			pushRunsWithNewline(blocks, runs);
		}
		paraLines.length = 0;
	};

	// Table detector: header row with pipes + separator row of dashes.
	const TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/u;
	// List row (captures indent, marker, optional checkbox, content).
	const LIST_ROW = /^(\s*)(?:([-*+])|(\d+)\.)\s+(?:\[([ xX])\]\s+)?(.*)$/u;

	const linesAll = md.split("\n");
	let i = 0;
	while (i < linesAll.length) {
		const rawLine = linesAll[i];
		if (rawLine === undefined) {
			break;
		}
		// List row (may be nested, may be a task checkbox) — computed up front
		// so it can slot into the if/else-if dispatch below without re-testing.
		const mList = LIST_ROW.exec(rawLine);
		const stripped = rawLine.trim();
		const nextLine = linesAll[i + 1];

		if (rawLine.startsWith("```")) {
			flushPara();
			if (inCode) {
				blocks.push({
					text: `${codeLines.join("\n")}\n`,
					attributes: { "code-block": true },
				});
				codeLines.length = 0;
			}
			inCode = !inCode;
			i += 1;
		} else if (inCode) {
			codeLines.push(rawLine);
			i += 1;
		} else if (!stripped) {
			flushPara();
			i += 1;
		} else if (stripped === "---" || stripped === "***" || stripped === "___") {
			flushPara();
			i += 1;
		} else if (
			// Table: header row containing a pipe, followed by a dashes-separator
			// row. ClickUp comments don't render tables, so we surface the pipes
			// inside a fenced code-block so the structure remains legible.
			rawLine.includes("|") &&
			nextLine !== undefined &&
			TABLE_SEP.test(nextLine.trim())
		) {
			flushPara();
			const tableRows: string[] = [rawLine, nextLine];
			let j = i + 2;
			let row = linesAll[j];
			while (row !== undefined && row.trim() && row.includes("|")) {
				tableRows.push(row);
				j += 1;
				row = linesAll[j];
			}
			blocks.push({
				text: `${tableRows.join("\n")}\n`,
				attributes: { "code-block": true },
			});
			i = j;
		} else if (stripped.startsWith("# ")) {
			flushPara();
			pushRunsWithNewline(blocks, splitInlineRuns(stripped.slice(2).trim(), { header: 1 }));
			i += 1;
		} else if (stripped.startsWith("## ")) {
			flushPara();
			pushRunsWithNewline(blocks, splitInlineRuns(stripped.slice(3).trim(), { header: 2 }));
			i += 1;
		} else if (stripped.startsWith("### ")) {
			flushPara();
			pushRunsWithNewline(blocks, splitInlineRuns(stripped.slice(4).trim(), { header: 3 }));
			i += 1;
		} else if (stripped.startsWith("> ")) {
			// Blockquote: paragraph-level attribute.
			flushPara();
			pushRunsWithNewline(blocks, splitInlineRuns(stripped.slice(2).trim(), { blockquote: true }));
			i += 1;
		} else if (mList) {
			flushPara();
			const [, indentStr, , orderedNum, checkbox, contentRaw] = mList;
			if (indentStr === undefined) {
				throw new Error("unexpected undefined");
			}
			const content = contentRaw ?? "";
			let listKind: string;
			if (checkbox === undefined) {
				listKind = orderedNum === undefined ? "unordered" : "ordered";
			} else {
				listKind = checkbox.toLowerCase() === "x" ? "checked" : "unchecked";
			}
			const attrs: Record<string, unknown> = { list: listKind };
			const indent = Math.floor(indentStr.length / 2);
			if (indent) {
				attrs.indent = indent;
			}
			// Preserve ordered-list starting number when not the default 1.
			// ClickUp's comment renderer may not honour `start`; recorded so
			// the numbering survives round-trips into structured consumers.
			if (orderedNum !== undefined && checkbox === undefined) {
				const startN = Math.trunc(Number(orderedNum));
				if (startN !== 1) {
					attrs.start = startN;
				}
			}
			pushRunsWithNewline(blocks, splitInlineRuns(content, attrs));
			i += 1;
		} else {
			paraLines.push(rawLine);
			i += 1;
		}
	}

	flushPara();
	if (inCode && codeLines.length > 0) {
		blocks.push({
			text: `${codeLines.join("\n")}\n`,
			attributes: { "code-block": true },
		});
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function httpJson(
	method: string,
	url: string,
	token: string,
	body: Record<string, unknown> | null = null,
): Promise<[number, Record<string, JsonValue>]> {
	// POST/PUT/DELETE to ClickUp and return (http_status, response_json).
	const headers: Record<string, string> = { Authorization: token };
	let data: string | undefined;
	if (body !== null) {
		data = JSON.stringify(body);
		headers["Content-Type"] = "application/json";
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	try {
		const resp = await fetch(url, {
			method,
			headers,
			body: data,
			signal: controller.signal,
		});
		const text = await resp.text();
		let parsed: Record<string, JsonValue>;
		try {
			parsed = text ? (JSON.parse(text) as Record<string, JsonValue>) : {};
		} catch {
			parsed = {};
		}
		return [resp.status, parsed];
	} finally {
		clearTimeout(timeout);
	}
}

// ---------------------------------------------------------------------------
// Speedup / ledger helpers
// ---------------------------------------------------------------------------

function hm(hours: number): string {
	// Format decimal hours as {h}h {m}m. Rounds minutes to nearest int.
	// pyRound() matches Python's banker's rounding on x.5 boundaries.
	const totalMin = pyRound(Number(hours) * 60);
	return `${Math.trunc(totalMin / 60)}h ${totalMin % 60}m`;
}

function speedupSuffix(proofDir: string): string {
	// If proof_dir/time-comparison.json exists, return a markdown suffix
	// summarising actual vs no-AI baseline. Empty string when absent or the
	// comparison has no baseline resolved.
	const compPath = join(proofDir, "time-comparison.json");
	if (!isFile(compPath)) {
		return "";
	}
	let comp: Record<string, JsonValue>;
	try {
		comp = JSON.parse(readFileSync(compPath, "utf8")) as Record<string, JsonValue>;
	} catch {
		return "";
	}
	const actual = comp.actual_hours;
	const bmin = comp.baseline_min_hours;
	const bmax = comp.baseline_max_hours;
	if (
		actual === undefined ||
		actual === null ||
		bmin === undefined ||
		bmin === null ||
		bmax === undefined ||
		bmax === null
	) {
		return "";
	}
	const smin = comp.speedup_min;
	const smax = comp.speedup_max;
	if (smin === undefined || smin === null || smax === undefined || smax === null) {
		return "";
	}
	return (
		"\n\n---\n" +
		`AI-assisted actual: ${hm(Number(actual))}. Without AI (estimate): ` +
		`${pyRound(Number(bmin))}-${pyRound(Number(bmax))}h. ` +
		`Speedup: ${Number(smin).toFixed(1)}-${Number(smax).toFixed(1)}x.\n`
	);
}

export function ledgerMarkdown(comparisonJsonPath: string): string {
	// Render a finding-effort ledger as bulleted markdown from a
	// time-comparison.json.
	//
	// Bulleted form is chosen deliberately over a markdown table:
	// mdToClickupBlocks (Part A audit) degrades tables into a fenced
	// code-block because ClickUp's comment API has no native `table`
	// attribute. A bulleted list renders as first-class ClickUp bullets with
	// per-run `bold` on the key, so every ledger row lands as legible
	// structured content rather than a wall of pipes.
	//
	// Missing fields render as an em-dash. The function never raises on
	// partial JSON -- an unreadable or partial file returns '' so the
	// caller can decide whether to suppress the section entirely.
	const p = comparisonJsonPath;
	if (!isFile(p)) {
		return "";
	}
	let comp: Record<string, JsonValue>;
	try {
		comp = JSON.parse(readFileSync(p, "utf8")) as Record<string, JsonValue>;
	} catch {
		return "";
	}
	const ledgerVal = comp.ledger;
	const ledger: Record<string, JsonValue> =
		ledgerVal && typeof ledgerVal === "object" && !Array.isArray(ledgerVal)
			? (ledgerVal as Record<string, JsonValue>)
			: {};
	const dash = "—";

	const g = (key: string, defaultV: JsonValue | undefined = undefined): JsonValue | undefined => {
		for (const src of [comp, ledger]) {
			if (key in src) {
				const v = src[key];
				if (v !== null && v !== "") {
					return v;
				}
			}
		}
		return defaultV;
	};

	const kfmt = (v: JsonValue | undefined): string => {
		if (v === undefined || v === null) {
			return dash;
		}
		const n = Number(v);
		if (Number.isNaN(n)) {
			return dash;
		}
		return `${pyRound(n / 1000)}k`;
	};

	const actual = comp.actual_hours;
	const actualFmt =
		actual !== undefined && actual !== null && actual !== 0 ? hm(Number(actual)) : dash;
	const bmin = comp.baseline_min_hours;
	const bmax = comp.baseline_max_hours;
	let baselineRange: string;
	let bminLbl: string | number;
	let bmaxLbl: string | number;
	if (bmin !== undefined && bmin !== null && bmax !== undefined && bmax !== null) {
		baselineRange = `${pyRound(Number(bmin))}-${pyRound(Number(bmax))} h`;
		bminLbl = pyRound(Number(bmin));
		bmaxLbl = pyRound(Number(bmax));
	} else {
		baselineRange = dash;
		bminLbl = dash;
		bmaxLbl = dash;
	}
	const smin = comp.speedup_min;
	const smax = comp.speedup_max;
	const speedup =
		smin !== undefined && smin !== null && smax !== undefined && smax !== null
			? `${Number(smin).toFixed(1)}-${Number(smax).toFixed(1)}x`
			: dash;

	const protocolRaw = comp.protocol;
	const protocol = typeof protocolRaw === "string" ? protocolRaw.toLowerCase() : "";
	let baselineKey: string;
	if (protocol === "srp") {
		baselineKey = "BASELINE_SRP";
	} else if (protocol === "sfp") {
		baselineKey = "BASELINE_SFP_PER_FINDING";
	} else if (protocol === "trp") {
		baselineKey = "BASELINE_TRP";
	} else {
		baselineKey = "BASELINE";
	}

	// pyOr matches Python `or` — falls through on 0/false/"", not just null/undefined.
	const emittedRaw = pyOr(g("emitted_iso"), g("emitted"));
	let emitted: string;
	if (emittedRaw) {
		emitted = String(emittedRaw);
	} else {
		emitted = new Date().toISOString().slice(0, 10);
	}

	const show = (v: JsonValue | undefined): JsonValue => {
		if (v === undefined || v === null || v === "") {
			return dash;
		}
		return v;
	};

	const model = show(g("model"));
	const inputK = kfmt(g("input_tokens"));
	const outputK = kfmt(g("output_tokens"));
	const cacheK = kfmt(pyOr(g("cache_read_tokens"), g("cache_tokens")));
	const cost = g("cost_usd");
	const costStr =
		cost !== undefined && cost !== null && cost !== "" ? Number(cost).toFixed(2) : dash;
	const subAgents = show(g("sub_agents"));
	const nRuns = show(pyOr(g("n_workflow_runs"), pyOr(g("workflow_runs"), g("n_runs"))));
	const nAdv = show(pyOr(g("n_adversarial_passes"), pyOr(g("adversarial_passes"), g("n_adv"))));

	const lines: string[] = [
		"# Finding effort ledger",
		"",
		"## Wall-clock",
		"",
		`- **AI-assisted**: ${actualFmt}`,
		`- **No-AI baseline**: ${baselineRange}`,
		`- **Speedup**: ${speedup}`,
		"",
		"## AI cost",
		"",
		`- **Model**: ${String(model)}`,
		`- **Input tokens**: ${inputK}`,
		`- **Output tokens**: ${outputK}`,
		`- **Cache read tokens**: ${cacheK}`,
		`- **Cost (USD)**: $${costStr}`,
		"",
		"## Methodology",
		"",
		`- **Sub-agents**: ${String(subAgents)}`,
		`- **Workflow runs**: ${String(nRuns)}`,
		`- **Adversarial refute passes**: ${String(nAdv)}`,
		`- **Emitted**: ${emitted}`,
		"",
		"## Baseline source",
		"",
		`_Per-finding SFP investigation + POC authoring, per \`baselines.env\` (${baselineKey}_MIN=${String(bminLbl)}, MAX=${String(bmaxLbl)}). Senior engineer familiar with codebase._`,
		"",
	];
	return lines.join("\n");
}

function stripDraftPrefix(commentBody: string): string {
	// The [SW] stage prefixes payload comment_body with a "TRP spike-writeup
	// draft\n---\n" banner intended for the fallback plain-text path. When we
	// render as blocks we drop it -- the writeup's own H1 (`# [SPIKE] ...`) is
	// what the reader wants at the top, not a duplicated draft banner.
	const prefix = "TRP spike-writeup draft\n---\n";
	return commentBody.startsWith(prefix) ? commentBody.slice(prefix.length) : commentBody;
}

// ---------------------------------------------------------------------------
// Live comment poster
// ---------------------------------------------------------------------------

async function postCommentLive(
	task: string,
	proofDir: string,
	statusTransition: string,
): Promise<number> {
	const payloadPath = join(proofDir, "comment-payload.json");
	if (!isFile(payloadPath)) {
		process.stderr.write(
			`no comment payload at ${payloadPath}. Run the [SW] stage of trp-run-loop.sh first (spike-writeup mode) so the driver drafts the payload.\n`,
		);
		return 4;
	}
	const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Record<string, JsonValue>;
	if (payload.posted === true) {
		process.stdout.write(
			`  payload already marked posted:true (comment_id=${String(payload.posted_comment_id ?? "?")}); nothing to do.\n`,
		);
		return 0;
	}

	const token = loadToken();
	const teamId = process.env.CLICKUP_TEAM_ID ?? "8593845";

	let bodyMd = stripDraftPrefix(
		typeof payload.comment_body === "string" ? payload.comment_body : "",
	);
	bodyMd += speedupSuffix(proofDir);
	if (!bodyMd.trim()) {
		process.stderr.write("empty comment_body in payload; refusing to post an empty comment.\n");
		return 4;
	}
	const blocks = mdToClickupBlocks(bodyMd);
	const totalChars = blocks.reduce((acc, b) => acc + (b.text ? b.text.length : 0), 0);
	process.stdout.write(`  POST comment: ${blocks.length} blocks (${totalChars} chars)\n`);

	const url = `${CLICKUP_API}/task/${task}/comment?custom_task_ids=true&team_id=${teamId}`;
	const [status, resp] = await httpJson("POST", url, token, {
		comment: blocks,
		notify_all: true,
		assignee: null,
	});
	if (status !== 200) {
		const errMsg = resp.err === undefined ? resp : resp.err;
		process.stderr.write(
			`  ClickUp comment POST failed: HTTP ${status} ${JSON.stringify(errMsg)}\n`,
		);
		return 4;
	}
	let commentId: JsonValue | undefined = resp.id;
	if (commentId === undefined || commentId === null) {
		const { version } = resp;
		if (version && typeof version === "object" && !Array.isArray(version)) {
			const { data } = version as Record<string, JsonValue>;
			if (data && typeof data === "object" && !Array.isArray(data)) {
				commentId = (data as Record<string, JsonValue>).object_id;
			}
		}
	}
	process.stdout.write(`  comment posted: id=${String(commentId ?? "None")}\n`);

	if (statusTransition) {
		const putUrl = `${CLICKUP_API}/task/${task}?custom_task_ids=true&team_id=${teamId}`;
		const [putStatus, putResp] = await httpJson("PUT", putUrl, token, {
			status: statusTransition,
		});
		if (putStatus === 200) {
			process.stdout.write(`  status transition applied: ${statusTransition}\n`);
		} else {
			const errMsg = putResp.err === undefined ? putResp : putResp.err;
			process.stderr.write(
				`  WARN: status transition to "${statusTransition}" failed HTTP ${putStatus} ${JSON.stringify(errMsg)} — comment did post\n`,
			);
		}
	}

	payload.posted = true;
	payload.posted_comment_id =
		commentId !== undefined && commentId !== null ? String(commentId) : null;
	payload.status_transition_applied = statusTransition;
	writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
	process.stdout.write(`  marked ${payloadPath} posted:true\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// Direct-run guard
// ---------------------------------------------------------------------------

function isDirectRun(): boolean {
	const entry = process.argv.at(1);
	if (!entry) {
		return false;
	}
	try {
		return realpathSync(import.meta.filename) === realpathSync(resolve(entry));
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		const code = await main();
		process.exit(code);
	} catch (error: unknown) {
		process.stderr.write(`tracker-post-proof: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
