#!/usr/bin/env node
/**
 * `tracker-fetch-task.ts` — polymorphic task fetcher for TRP, ported from
 * `trp/scripts/tracker-fetch-task.py`.
 *
 * Reads TRACKER_TYPE from env (clickup / linear / jira / github-issue) and
 * fetches a task by id, normalising the response to a stable JSON shape under
 * discovery/task-<slug>.json so downstream stages (design, patch, verify) see
 * the same fields regardless of tracker.
 *
 * Only ClickUp is implemented here; the other trackers stub with a clear
 * error. GET-only — TRP hard rule is no remote mutation from this script
 * (TRP_ALLOW_REMOTE_MUTATE gates writes elsewhere, never here).
 *
 * Token handling: reads CLICKUP_TOKEN_FILE (trp.env default .env.clickup),
 * resolved relative to the trp repo root. Falls back to a secondary token
 * path ONLY when the trp token file is absent AND TRP_ALLOW_FALLBACK_TOKEN=true
 * is set (path via TRP_FALLBACK_TOKEN_DIR) — otherwise refuses loudly so an
 * operator running in the wrong scope hears about it (SR11 / Rule 12).
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { pyOr } from "./pyshim.ts";

const REPO_ROOT: string = dirname(import.meta.dirname);
const FALLBACK_TOKEN_DIR: string | null = process.env.TRP_FALLBACK_TOKEN_DIR || null;
const API = "https://api.clickup.com/api/v2";

function die(msg: string, code: number = 2): never {
	process.stderr.write(`ERROR: ${msg}\n`);
	process.exit(code);
}

export function parseTaskArg(value: string): [string | null, string] {
	// Split TRACKER:TASK_ID. Tracker is optional; falls through to env.
	if (!value.includes(":")) {
		return [null, value];
	}
	const idx = value.indexOf(":");
	const tracker = value.slice(0, idx).trim().toLowerCase();
	const taskId = value.slice(idx + 1).trim();
	return [tracker || null, taskId];
}

export function readTokenFile(path: string): string {
	// Accept a bare pk_ line or KEY=VALUE lines (CLICKUP_TOKEN=pk_...).
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		die(`no ClickUp token found in ${path} (expected pk_... or CLICKUP_TOKEN=...)`);
	}
	for (const raw of contents.split(/\r?\n/u)) {
		const line = raw.trim();
		if (line && !line.startsWith("#")) {
			if (line.startsWith("pk_")) {
				return line;
			}
			if (line.includes("=")) {
				const eq = line.indexOf("=");
				const key = line.slice(0, eq).trim();
				let val = line.slice(eq + 1);
				if (key === "CLICKUP_TOKEN" || key === "TOKEN") {
					val = val
						.trim()
						.replaceAll(/^"+|"+$/gu, "")
						.replaceAll(/^'+|'+$/gu, "");
					if (val) {
						return val;
					}
				}
			}
		}
	}
	die(`no ClickUp token found in ${path} (expected pk_... or CLICKUP_TOKEN=...)`);
}

export function loadClickupToken(): string {
	// Read the ClickUp token from disk. See module header for fallback rules.
	const tokenFileRel = process.env.CLICKUP_TOKEN_FILE ?? ".env.clickup";
	const primary = join(REPO_ROOT, tokenFileRel);
	if (existsSync(primary)) {
		return readTokenFile(primary);
	}
	if (
		(process.env.TRP_ALLOW_FALLBACK_TOKEN ?? "").toLowerCase() === "true" &&
		FALLBACK_TOKEN_DIR !== null
	) {
		const fallback = join(FALLBACK_TOKEN_DIR, ".env.clickup");
		if (existsSync(fallback)) {
			process.stderr.write(`NOTE: using fallback token at ${fallback}\n`);
			return readTokenFile(fallback);
		}
	}
	die(
		`ClickUp token file not found at ${primary}. ` +
			"Create it (pk_XXX_...) or set TRP_ALLOW_FALLBACK_TOKEN=true " +
			"and TRP_FALLBACK_TOKEN_DIR=<dir> to reuse another token.",
	);
}

export async function clickupGet(
	path: string,
	token: string,
	query?: Record<string, string> | null,
): Promise<unknown> {
	let url = `${API}${path}`;
	if (query) {
		const params = new URLSearchParams(query);
		url += `?${params.toString()}`;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: { Authorization: token, Accept: "application/json" },
			signal: controller.signal,
		});
	} catch (error: unknown) {
		clearTimeout(timer);
		die(`ClickUp GET ${path} -> ${String(error)}`);
	}
	clearTimeout(timer);
	const body = await response.text();
	if (!response.ok) {
		die(`ClickUp GET ${path} -> ${response.status}\n${body}`);
	}
	return JSON.parse(body || "{}");
}

function loadMock(path: string): unknown {
	if (!existsSync(path)) {
		die(`mock fixture not found: ${path}`);
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error: unknown) {
		die(`mock fixture is not valid JSON: ${path} (${String(error)})`);
	}
	try {
		return JSON.parse(raw);
	} catch (error: unknown) {
		die(`mock fixture is not valid JSON: ${path} (${String(error)})`);
	}
}

type ClickupTriple = readonly [Record<string, unknown>, readonly unknown[], readonly unknown[]];

export async function fetchClickup(
	taskId: string,
	mockPath?: string | null,
): Promise<ClickupTriple> {
	// Return (task, comments, attachments) either from a mock or the API.
	if (mockPath) {
		const payload = loadMock(mockPath) as Record<string, unknown>;
		const task = payload.task === undefined ? payload : (payload.task as Record<string, unknown>);
		const comments = Array.isArray(payload.comments) ? payload.comments : [];
		const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
		return [task, comments, attachments];
	}

	const token = loadClickupToken();
	const query: Record<string, string> = {};
	// Custom task ids (e.g. HAND_ITC-308) require the team scope. Detect by the
	// presence of a non-digit prefix — pure-numeric ClickUp ids are the default
	// short id and do not need the flag.
	if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/u.test(taskId)) {
		const teamId = (process.env.CLICKUP_TEAM_ID ?? "").trim();
		if (!teamId) {
			die(
				`task id ${taskId} looks like a custom id (needs CLICKUP_TEAM_ID). ` +
					"Set CLICKUP_TEAM_ID in trp.env.local.",
			);
		}
		query.custom_task_ids = "true";
		query.team_id = teamId;
	}

	const hasQuery = Object.keys(query).length > 0;
	const q: Record<string, string> | null = hasQuery ? query : null;
	const task = (await clickupGet(`/task/${taskId}`, token, q)) as Record<string, unknown>;
	const commentsRaw = await clickupGet(`/task/${taskId}/comment`, token, q);
	const attachRaw = await clickupGet(`/task/${taskId}/attachment`, token, q);
	// /comment returns {"comments": [...]}; /attachment returns a bare list on
	// some versions and {"attachments": [...]} on others — normalise both.
	let comments: readonly unknown[];
	if (commentsRaw !== null && typeof commentsRaw === "object" && !Array.isArray(commentsRaw)) {
		const c = (commentsRaw as Record<string, unknown>).comments;
		comments = Array.isArray(c) ? c : [];
	} else {
		comments = Array.isArray(commentsRaw) ? commentsRaw : [];
	}
	let attachments: readonly unknown[];
	if (attachRaw !== null && typeof attachRaw === "object" && !Array.isArray(attachRaw)) {
		const ar = attachRaw as Record<string, unknown>;
		const { attachments: arAttachments, data: arData } = ar;
		if (Array.isArray(arAttachments)) {
			attachments = arAttachments;
		} else if (Array.isArray(arData)) {
			attachments = arData;
		} else {
			attachments = [];
		}
	} else {
		attachments = Array.isArray(attachRaw) ? attachRaw : [];
	}
	return [task, comments, attachments];
}

function asObject(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

function get(o: unknown, key: string): unknown {
	if (o !== null && typeof o === "object" && !Array.isArray(o)) {
		return (o as Record<string, unknown>)[key];
	}
	return undefined;
}

export function normaliseClickup(
	task: Record<string, unknown>,
	comments: readonly unknown[],
	attachments: readonly unknown[],
): Record<string, unknown> {
	// Map ClickUp's raw shape to the stable TRP task record.
	const statusRaw = pyOr(task.status, {} as Record<string, unknown>);
	const priorityRaw = pyOr(task.priority, {} as Record<string, unknown>);
	const statusIsObj =
		statusRaw !== null && typeof statusRaw === "object" && !Array.isArray(statusRaw);
	const priorityIsObj =
		priorityRaw !== null && typeof priorityRaw === "object" && !Array.isArray(priorityRaw);
	const status = asObject(statusRaw);
	const priority = asObject(priorityRaw);
	const assigneesRaw = pyOr(task.assignees, [] as unknown[]) as unknown[];
	return {
		task_id: task.id,
		title: task.name,
		description: pyOr(task.text_content, task.description),
		status: {
			status: statusIsObj ? status.status : statusRaw,
			type: statusIsObj ? status.type : null,
		},
		priority: {
			priority: priorityIsObj ? priority.priority : priorityRaw,
		},
		assignees: assigneesRaw.map((a: unknown) => ({
			id: get(a, "id"),
			username: get(a, "username"),
			email: get(a, "email"),
		})),
		custom_fields: task.custom_fields ?? [],
		comments: comments.map((c: unknown) => ({
			id: get(c, "id"),
			user: get(pyOr(get(c, "user"), {} as Record<string, unknown>), "username") ?? null,
			date: get(c, "date"),
			text: get(c, "comment_text"),
		})),
		attachments: attachments.map((a: unknown) => ({
			id: get(a, "id"),
			title: get(a, "title"),
			url: get(a, "url"),
			extension: get(a, "extension"),
		})),
		subtasks: task.subtasks ?? [],
		updated_at: task.date_updated,
		url: task.url,
		_raw: { task, comments, attachments },
	};
}

export function slugify(taskId: string): string {
	return taskId
		.replaceAll(/[^A-Za-z0-9_-]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "")
		.toLowerCase();
}

type ParsedArgs = {
	readonly task: string;
	readonly mock: string | null;
	readonly outDir: string | null;
};

function printUsage(stream: NodeJS.WriteStream): void {
	stream.write("usage: tracker-fetch-task.ts [-h] --task TASK [--mock MOCK] [--out-dir OUT_DIR]\n");
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	let task: string | null = null;
	let mock: string | null = null;
	let outDir: string | null = null;
	let i = 0;
	while (i < argv.length) {
		const a = argv[i];
		if (a === undefined) {
			break;
		}
		if (a === "-h" || a === "--help") {
			printUsage(process.stdout);
			process.stdout.write(
				"\nFetch a tracker task and normalise it to discovery/task-<slug>.json.\n",
			);
			process.stdout.write("\nExample: tracker-fetch-task.ts --task clickup:HAND_ITC-308\n");
			process.exit(0);
		} else if (a === "--task") {
			task = argv[i + 1] ?? "";
			i += 2;
		} else if (a.startsWith("--task=")) {
			task = a.slice("--task=".length);
			i += 1;
		} else if (a === "--mock") {
			mock = argv[i + 1] ?? "";
			i += 2;
		} else if (a.startsWith("--mock=")) {
			mock = a.slice("--mock=".length);
			i += 1;
		} else if (a === "--out-dir") {
			outDir = argv[i + 1] ?? "";
			i += 2;
		} else if (a.startsWith("--out-dir=")) {
			outDir = a.slice("--out-dir=".length);
			i += 1;
		} else {
			printUsage(process.stderr);
			process.stderr.write(`tracker-fetch-task.ts: error: unrecognized argument: ${a}\n`);
			process.exit(2);
		}
	}
	if (task === null) {
		printUsage(process.stderr);
		process.stderr.write(
			"tracker-fetch-task.ts: error: the following arguments are required: --task\n",
		);
		process.exit(2);
	}
	return { task, mock, outDir };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const args = parseArgs(argv);

	const [trackerFromArg, taskId] = parseTaskArg(args.task);
	const tracker = (trackerFromArg ?? process.env.TRACKER_TYPE ?? "").trim().toLowerCase();
	if (!tracker) {
		die("no tracker specified. Use --task clickup:ID or set TRACKER_TYPE.");
	}

	let mockPath: string | null = args.mock;
	if (!mockPath && (process.env.TRP_MOCK ?? "").toLowerCase() === "true") {
		mockPath = process.env.TRP_MOCK_FIXTURE ?? null;
		if (!mockPath) {
			die("TRP_MOCK=true but TRP_MOCK_FIXTURE is unset.");
		}
	}

	let record: Record<string, unknown>;
	if (tracker === "clickup") {
		const [task, comments, attachments] = await fetchClickup(taskId, mockPath);
		record = normaliseClickup(task, comments, attachments);
	} else if (tracker === "linear" || tracker === "jira" || tracker === "github-issue") {
		throw new Error(
			`tracker '${tracker}' is not implemented yet. ` +
				"Only clickup is wired up; add a fetch/normalise pair to extend.",
		);
	} else {
		die(`unknown tracker '${tracker}'. Expected: clickup, linear, jira, github-issue.`);
	}

	const outDir = args.outDir ? resolve(args.outDir) : join(REPO_ROOT, "discovery");
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, `task-${slugify(taskId)}.json`);
	writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
	process.stdout.write(`${outPath}\n`);
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
		await main();
	} catch (error: unknown) {
		process.stderr.write(`tracker-fetch-task: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
