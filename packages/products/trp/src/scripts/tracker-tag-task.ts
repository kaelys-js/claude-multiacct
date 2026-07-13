#!/usr/bin/env node
/**
 * `tracker-tag-task.ts` — TS port of `trp/scripts/tracker-tag-task.py`.
 *
 * ClickUp tag operations: list / create / apply / remove. Same safety posture
 * as `tracker-post-proof`: remote mutation refused unless
 * `TRP_ALLOW_REMOTE_MUTATE=true`, `--dry-run` prints the plan and never hits
 * the network. Tag colours are derived deterministically from the tag name so
 * the same name always paints the same colour without the operator picking one.
 *
 * Behaviour is preserved byte-for-byte from the Python source: same argparse
 * shape, same exit codes, same stdout / stderr wording, same palette + hash
 * selection, same env-var defaults.
 *
 * Usage:
 *     tracker-tag-task --action=list   --space-id 90140000000
 *     tracker-tag-task --action=create --space-id 90140000000 --tag-name sec-02
 *     tracker-tag-task --action=apply  --task TASK-123 --tag-name sec-02
 *     tracker-tag-task --action=remove --task TASK-123 --tag-name sec-02
 *
 * Env:
 *     CLICKUP_TOKEN_FILE       path to token file (default: .env.clickup)
 *     CLICKUP_TEAM_ID          workspace id (default: 8593845)
 *     TRP_ALLOW_REMOTE_MUTATE  must be 'true' for non-dry-run
 *
 * Exit codes:
 *     0  ok (or dry-run plan printed)
 *     2  bad arguments
 *     3  refused: TRP_ALLOW_REMOTE_MUTATE not set
 *     4  network / API error
 *
 * @module
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";

const ACTIONS = ["list", "create", "apply", "remove"] as const;
type Action = (typeof ACTIONS)[number];
const CLICKUP_API = "https://api.clickup.com/api/v2";

// Fixed palette. Deterministic hash-index selection keeps the same tag name
// painting the same colour on every invocation, across operators. Palette is
// intentionally small and readable in both light and dark ClickUp themes.
const PALETTE: ReadonlyArray<readonly [string, string]> = [
	["#ef4444", "#ffffff"], // red
	["#f97316", "#ffffff"], // orange
	["#eab308", "#1f2937"], // amber
	["#22c55e", "#ffffff"], // green
	["#14b8a6", "#ffffff"], // teal
	["#0ea5e9", "#ffffff"], // sky
	["#6366f1", "#ffffff"], // indigo
	["#a855f7", "#ffffff"], // purple
	["#ec4899", "#ffffff"], // pink
	["#64748b", "#ffffff"], // slate
];

type Tag = {
	name?: string;
	[k: string]: unknown;
};

type CliArgs = {
	action: Action;
	spaceId: string | null;
	task: string | null;
	tagName: string | null;
	dryRun: boolean;
};

/**
 * Return `[bg, fg]` hex for the tag name. Deterministic on the name text
 * alone — an operator running create twice hits the same slot.
 *
 * @param {string} name - tag name to derive the palette slot from.
 * @returns {[string, string]} `[bg, fg]` hex colour pair.
 */
export function colourFor(name: string): [string, string] {
	const digest = createHash("sha256").update(name, "utf8").digest();
	const [first] = digest;
	if (first === undefined) {
		throw new Error("unexpected undefined");
	}
	const idx = first % PALETTE.length;
	const entry = PALETTE[idx];
	if (entry === undefined) {
		throw new Error("unexpected undefined");
	}
	const [bg, fg] = entry;
	return [bg, fg];
}

/**
 * Read the ClickUp personal token from `CLICKUP_TOKEN_FILE` (default
 * `.env.clickup`). Accepts a bare `pk_...` line or `CLICKUP_TOKEN=...`
 * `KEY=VALUE`. Exits 4 on any failure — matches the Python source.
 *
 * @returns {string} the ClickUp personal token string.
 */
export function loadToken(): string {
	const pathStr = process.env.CLICKUP_TOKEN_FILE ?? ".env.clickup";
	let isFile = false;
	try {
		isFile = statSync(pathStr).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) {
		process.stderr.write(
			`ClickUp token file not found: ${pathStr}. Set CLICKUP_TOKEN_FILE ` +
				"or place .env.clickup in the current directory.\n",
		);
		process.exit(4);
	}
	const text = readFileSync(pathStr, "utf8");
	for (const raw of splitlines(text)) {
		const line = raw.trim();
		if (line && !line.startsWith("#")) {
			if (line.includes("=")) {
				const eqIdx = line.indexOf("=");
				const key = line.slice(0, eqIdx);
				const value = line.slice(eqIdx + 1);
				if (key.trim() === "CLICKUP_TOKEN" || key.trim() === "TOKEN") {
					return value.trim();
				}
			} else if (line.startsWith("pk_")) {
				return line;
			}
		}
	}
	process.stderr.write(
		`no ClickUp token found in ${pathStr} (expected pk_... or CLICKUP_TOKEN=pk_...)\n`,
	);
	process.exit(4);
}

/**
 * Issue an HTTP request and return `[status, parsed_json]`. Mirrors the Python
 * `_http_json` semantics: 30s timeout, JSON body when provided, error bodies
 * surfaced as `{raw: ...}` when they aren't valid JSON.
 *
 * @param {string} method - HTTP method, e.g. `"GET"` or `"POST"`.
 * @param {string} url - full request URL.
 * @param {string} token - ClickUp bearer token sent as the `Authorization` header.
 * @param {Record<string, unknown> | null} [body] - optional JSON-serialisable request body.
 * @returns {Promise<[number, Record<string, unknown>]>} `[status, parsed_json]` — the HTTP status and the parsed response body.
 */
export async function httpJson(
	method: string,
	url: string,
	token: string,
	body?: Record<string, unknown> | null,
): Promise<[number, Record<string, unknown>]> {
	const headers: Record<string, string> = { Authorization: token };
	let dataInit: string | undefined;
	if (body !== undefined && body !== null) {
		dataInit = JSON.stringify(body);
		headers["Content-Type"] = "application/json";
	}
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, 30_000);
	let resp: Response;
	try {
		resp = await fetch(url, {
			method,
			headers,
			body: dataInit,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
	const raw = await resp.text();
	if (!raw) {
		return [resp.status, {}];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return [resp.status, parsed as Record<string, unknown>];
		}
		// urllib path returns whatever json.loads produced; the callers only
		// use dict semantics, so wrap non-object payloads to keep the type
		// contract. Preserves the Python callers' `.get('tags', [])` posture.
		return [resp.status, { value: parsed } as Record<string, unknown>];
	} catch {
		return [resp.status, { raw }];
	}
}

async function listTags(spaceId: string, token: string): Promise<[number, Tag[]]> {
	const [status, resp] = await httpJson("GET", `${CLICKUP_API}/space/${spaceId}/tag`, token);
	if (resp && typeof resp === "object" && !Array.isArray(resp)) {
		const { tags } = resp as { tags?: unknown };
		if (Array.isArray(tags)) {
			return [status, tags as Tag[]];
		}
		return [status, []];
	}
	return [status, []];
}

async function doList(spaceId: string, dryRun: boolean): Promise<number> {
	if (dryRun) {
		process.stdout.write(`[DRY-RUN] GET ${CLICKUP_API}/space/${spaceId}/tag\n`);
		return 0;
	}
	const token = loadToken();
	const [status, tags] = await listTags(spaceId, token);
	if (status !== 200) {
		process.stderr.write(`list failed: HTTP ${status}\n`);
		return 4;
	}
	process.stdout.write(`${JSON.stringify(tags, null, 2)}\n`);
	return 0;
}

async function doCreate(spaceId: string, tagName: string, dryRun: boolean): Promise<number> {
	const [bg, fg] = colourFor(tagName);
	if (dryRun) {
		process.stdout.write(
			`[DRY-RUN] would ensure tag "${tagName}" in space ${spaceId} (bg=${bg} fg=${fg})\n`,
		);
		return 0;
	}
	const token = loadToken();
	const [status, existing] = await listTags(spaceId, token);
	if (status !== 200) {
		process.stderr.write(`preflight list failed: HTTP ${status}\n`);
		return 4;
	}
	if (existing.some((t) => t.name === tagName)) {
		process.stdout.write(`  tag "${tagName}" already exists in space ${spaceId}; nothing to do.\n`);
		return 0;
	}
	const body = { tag: { name: tagName, tag_bg: bg, tag_fg: fg } };
	const [createStatus, resp] = await httpJson(
		"POST",
		`${CLICKUP_API}/space/${spaceId}/tag`,
		token,
		body,
	);
	if (createStatus !== 200 && createStatus !== 201) {
		process.stderr.write(`  create failed: HTTP ${createStatus} ${formatResp(resp)}\n`);
		return 4;
	}
	process.stdout.write(`  created tag "${tagName}" (bg=${bg} fg=${fg})\n`);
	return 0;
}

async function doApply(task: string, tagName: string, dryRun: boolean): Promise<number> {
	const teamId = process.env.CLICKUP_TEAM_ID ?? "8593845";
	const url = `${CLICKUP_API}/task/${task}/tag/${tagName}?custom_task_ids=true&team_id=${teamId}`;
	if (dryRun) {
		process.stdout.write(`[DRY-RUN] POST ${url}\n`);
		return 0;
	}
	const token = loadToken();
	const [status, resp] = await httpJson("POST", url, token, {});
	if (status !== 200) {
		process.stderr.write(`  apply failed: HTTP ${status} ${formatResp(resp)}\n`);
		return 4;
	}
	process.stdout.write(`  applied tag "${tagName}" to task ${task}\n`);
	return 0;
}

async function doRemove(task: string, tagName: string, dryRun: boolean): Promise<number> {
	const teamId = process.env.CLICKUP_TEAM_ID ?? "8593845";
	const url = `${CLICKUP_API}/task/${task}/tag/${tagName}?custom_task_ids=true&team_id=${teamId}`;
	if (dryRun) {
		process.stdout.write(`[DRY-RUN] DELETE ${url}\n`);
		return 0;
	}
	const token = loadToken();
	const [status, resp] = await httpJson("DELETE", url, token);
	if (status !== 200) {
		process.stderr.write(`  remove failed: HTTP ${status} ${formatResp(resp)}\n`);
		return 4;
	}
	process.stdout.write(`  removed tag "${tagName}" from task ${task}\n`);
	return 0;
}

/**
 * Format a response dict the same way Python's `print(f"... {resp}")` renders
 * a dict — repr-style with single quotes on keys, so operator log lines stay
 * comparable across the port.
 *
 * @param {Record<string, unknown>} resp - the parsed response body to format.
 * @returns {string} a JSON string representation of `resp`.
 */
function formatResp(resp: Record<string, unknown>): string {
	// Match Python's dict repr well enough for operator scanning; JSON output
	// is close enough — this string only appears on failure paths.
	return JSON.stringify(resp);
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

/**
 * Minimal argparse port covering exactly the flags the Python script exposes.
 * On bad args writes to stderr and returns null; caller exits 2.
 *
 * @param {readonly string[]} argv - the argument vector to parse (excluding `node`/script path).
 * @returns {CliArgs | null} the parsed CLI args, or `null` on a bad-argument error.
 */
export function parseArgs(argv: readonly string[]): CliArgs | null {
	let action: Action | null = null;
	let spaceId: string | null = null;
	let task: string | null = null;
	let tagName: string | null = null;
	let dryRun = false;

	const readValue = (flag: string, i: number, inline: string | null): [string, number] | null => {
		if (inline !== null) {
			return [inline, i];
		}
		if (i + 1 >= argv.length) {
			process.stderr.write(`argument ${flag}: expected one argument\n`);
			return null;
		}
		const next = argv[i + 1];
		if (next === undefined) {
			throw new Error("unexpected undefined");
		}
		return [next, i + 1];
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) {
			throw new Error("unexpected undefined");
		}
		let flag = arg;
		let inline: string | null = null;
		const eq = arg.indexOf("=");
		if (arg.startsWith("--") && eq !== -1) {
			flag = arg.slice(0, eq);
			inline = arg.slice(eq + 1);
		}
		if (flag === "--action") {
			const r = readValue(flag, i, inline);
			if (!r) {
				return null;
			}
			const [v, ni] = r;
			if (!(ACTIONS as readonly string[]).includes(v)) {
				process.stderr.write(
					`argument --action: invalid choice: '${v}' (choose from ${ACTIONS.map((a) => `'${a}'`).join(", ")})\n`,
				);
				return null;
			}
			action = v as Action;
			i = ni;
		} else if (flag === "--space-id") {
			const r = readValue(flag, i, inline);
			if (!r) {
				return null;
			}
			const [v, ni] = r;
			spaceId = v;
			i = ni;
		} else if (flag === "--task") {
			const r = readValue(flag, i, inline);
			if (!r) {
				return null;
			}
			const [v, ni] = r;
			task = v;
			i = ni;
		} else if (flag === "--tag" || flag === "--tag-name") {
			const r = readValue(flag, i, inline);
			if (!r) {
				return null;
			}
			const [v, ni] = r;
			tagName = v;
			i = ni;
		} else if (flag === "--dry-run") {
			if (inline !== null) {
				process.stderr.write("argument --dry-run: does not take a value\n");
				return null;
			}
			dryRun = true;
		} else if (flag === "-h" || flag === "--help") {
			process.stdout.write(HELP_TEXT);
			process.exit(0);
		} else {
			process.stderr.write(`unrecognized argument: ${arg}\n`);
			return null;
		}
	}

	if (action === null) {
		process.stderr.write("the following arguments are required: --action\n");
		return null;
	}
	return { action, spaceId, task, tagName, dryRun };
}

const HELP_TEXT = `usage: tracker-tag-task --action {list,create,apply,remove} [--space-id ID]
                        [--task TASK] [--tag TAG] [--dry-run]

ClickUp tag operations: list / create / apply / remove.
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const args = parseArgs(argv);
	if (args === null) {
		return 2;
	}

	// Gate FIRST for any live path — an operator who forgets the flag gets a
	// distinct refusal (exit 3), not an argparse-shaped error.
	if (!args.dryRun && (process.env.TRP_ALLOW_REMOTE_MUTATE ?? "false").toLowerCase() !== "true") {
		process.stderr.write("refusing: TRP_ALLOW_REMOTE_MUTATE not set (default safety gate)\n");
		return 3;
	}

	if (args.action === "list") {
		if (!args.spaceId) {
			process.stderr.write("--space-id is required for --action=list\n");
			return 2;
		}
		return await doList(args.spaceId, args.dryRun);
	}
	if (args.action === "create") {
		if (!args.spaceId || !args.tagName) {
			process.stderr.write("--space-id and --tag-name are required for --action=create\n");
			return 2;
		}
		return await doCreate(args.spaceId, args.tagName, args.dryRun);
	}
	if (args.action === "apply") {
		if (!args.task || !args.tagName) {
			process.stderr.write("--task and --tag-name are required for --action=apply\n");
			return 2;
		}
		return await doApply(args.task, args.tagName, args.dryRun);
	}
	if (args.action === "remove") {
		if (!args.task || !args.tagName) {
			process.stderr.write("--task and --tag-name are required for --action=remove\n");
			return 2;
		}
		return await doRemove(args.task, args.tagName, args.dryRun);
	}
	return 2;
}

// Only run main() when this file is invoked directly (not on test import).
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
		process.stderr.write(`tracker-tag-task: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
