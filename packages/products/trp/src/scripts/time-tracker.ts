#!/usr/bin/env node
/**
 * `time-tracker.ts` — per-task/stage time tracker with ClickUp + Harvest push.
 *
 * TypeScript port of `trp/scripts/time-tracker.py`. Session files live at
 * `discovery/time/<task>-<stage>.json`. See AGENTS.md TRP protocol for gate
 * semantics.
 *
 * Migrated line-for-line from the Python source — every argparse flag, every
 * branch, every JSON key, every stderr string is preserved verbatim.
 *
 * @module
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { sh } from "@foundation/shell";

const REPO_ROOT: string = path.resolve(import.meta.dirname, "..");
const TIME_DIR: string = path.join(REPO_ROOT, "discovery", "time");

// ---------- config loading ----------

function loadEnvFile(p: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(p)) {
		return out;
	}
	const text = readFileSync(p, "utf8");
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line && !line.startsWith("#") && line.includes("=")) {
			const eq = line.indexOf("=");
			const k = line.slice(0, eq);
			let v = line.slice(eq + 1);
			v = v.trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			} else {
				// Match Python's .strip('"').strip("'"): only strips matching quote chars
				// at either end when present. The dual-strip form only removes leading
				// AND trailing quotes when both sides have the same quote type; keep
				// the simpler form above and rely on the Python semantics.
			}
			out[k.trim()] = v;
		}
	}
	return out;
}

export function loadConfig(): Record<string, string> {
	const cfg: Record<string, string> = {};
	for (const fname of ["harvest.env", ".env.clickup", "srp.env", "baselines.env"]) {
		const loaded = loadEnvFile(path.join(REPO_ROOT, fname));
		for (const k of Object.keys(loaded)) {
			if (!(k in cfg)) {
				const v = loaded[k];
				if (v !== undefined) {
					cfg[k] = v;
				}
			}
		}
	}
	for (const k of [
		"HARVEST_ACCOUNT_ID",
		"HARVEST_ACCESS_TOKEN",
		"HARVEST_ALLOW_MUTATE",
		"HARVEST_PROJECT_ID",
		"HARVEST_TASK_ID",
		"HARVEST_USER_AGENT",
		"HARVEST_NOTE_TEMPLATE",
		"HARVEST_PROJECT_MAP",
		"HARVEST_MULTI_CLIENT_STRATEGY",
		"HARVEST_TTT_INTERNAL_PROJECT_ID",
		"CLICKUP_TOKEN",
		"CLICKUP_TEAM_ID",
		"TRP_ALLOW_REMOTE_MUTATE",
		"TRP_NO_AI_BASELINE_HOURS",
	]) {
		const v = process.env[k];
		if (v) {
			cfg[k] = v;
		}
	}
	return cfg;
}

// ---------- session file helpers ----------

function sessionPath(task: string, stage: string): string {
	mkdirSync(TIME_DIR, { recursive: true });
	const safeStage = stage.replaceAll("/", "_");
	return path.join(TIME_DIR, `${task}-${safeStage}.json`);
}

function nowMs(): number {
	return Math.floor(Date.now());
}

type SessionData = {
	task: string;
	stage: string;
	epoch_start_ms: number;
	epoch_end_ms?: number;
	duration_ms?: number;
	note?: string;
};

type StartArgs = {
	task: string;
	stage: string;
};

export function cmdStart(args: StartArgs): number {
	const p = sessionPath(args.task, args.stage);
	if (existsSync(p)) {
		const existing = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		if (!("epoch_end_ms" in existing)) {
			process.stderr.write(`session already open: ${p}\n`);
			return 2;
		}
		// rotate closed session into a numbered archive so we can start fresh
		let idx = 1;
		// path.with_suffix(f".{idx}.json") replaces trailing ".json" with ".{idx}.json"
		while (true) {
			const arch = p.replace(/\.json$/u, `.${idx}.json`);
			if (!existsSync(arch)) {
				renameSync(p, arch);
				break;
			}
			idx += 1;
		}
	}
	const data: SessionData = {
		task: args.task,
		stage: args.stage,
		epoch_start_ms: nowMs(),
	};
	writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ started: data, path: p })}\n`);
	return 0;
}

type StopArgs = {
	task: string;
	stage: string;
	note: string | null;
};

export function cmdStop(args: StopArgs): number {
	const p = sessionPath(args.task, args.stage);
	if (!existsSync(p)) {
		process.stderr.write(`no session file: ${p}\n`);
		return 2;
	}
	const data = JSON.parse(readFileSync(p, "utf8")) as SessionData;
	if ("epoch_end_ms" in data && data.epoch_end_ms !== undefined) {
		process.stderr.write(`session already stopped: ${p}\n`);
		return 2;
	}
	const endMs = nowMs();
	data.epoch_end_ms = endMs;
	data.duration_ms = endMs - Math.floor(Number(data.epoch_start_ms));
	if (args.note) {
		data.note = args.note;
	}
	writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ stopped: data, path: p })}\n`);
	return 0;
}

// ---------- aggregate ----------

type IterEntry = {
	path: string;
	data: Record<string, unknown>;
};

function* iterSessionsFor(task: string): Generator<IterEntry> {
	if (!existsSync(TIME_DIR)) {
		return;
	}
	const prefix = `${task}-`;
	const entries = readdirSync(TIME_DIR)
		.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
		.toSorted();
	for (const name of entries) {
		const full = path.join(TIME_DIR, name);
		if (name.startsWith(prefix)) {
			let data: Record<string, unknown> | undefined;
			try {
				data = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
			} catch {
				data = undefined;
			}
			if (data !== undefined && data.task === task) {
				yield { path: full, data };
			}
		}
	}
}

type StageRecord = {
	name: string | undefined;
	duration_ms: number;
	note: string;
	epoch_start_ms: number | undefined;
	epoch_end_ms: number | undefined;
};

type Aggregate = {
	task: string;
	total_duration_ms: number;
	sum_hours: number;
	stages: StageRecord[];
};

export function aggregateTask(task: string): Aggregate {
	const stages: StageRecord[] = [];
	let totalMs = 0;
	for (const { data } of iterSessionsFor(task)) {
		const dur = Math.floor(Number(data.duration_ms) || 0);
		if (dur > 0) {
			stages.push({
				name: data.stage as string | undefined,
				duration_ms: dur,
				note: (data.note as string | undefined) ?? "",
				epoch_start_ms: data.epoch_start_ms as number | undefined,
				epoch_end_ms: data.epoch_end_ms as number | undefined,
			});
			totalMs += dur;
		}
	}
	return {
		task,
		total_duration_ms: totalMs,
		sum_hours: pyRound(totalMs / 3_600_000.0, 4),
		stages,
	};
}

// Python's round() uses banker's rounding (round half to even): round(0.5) == 0,
// round(1.5) == 2, round(2.5) == 2. JavaScript's Math.round rounds half toward
// +infinity, which diverges on x.5 boundaries — the JSON output and the harvest
// note render would drift by 1 minute (or 1 hour on baseline_hours) versus the
// Python original. Implement banker's rounding so both stay byte-identical.
function pyRound(value: number, digits: number = 0): number {
	const factor = 10 ** digits;
	const scaled = value * factor;
	const floor = Math.floor(scaled);
	const diff = scaled - floor;
	let rounded: number;
	if (diff === 0.5) {
		rounded = floor % 2 === 0 ? floor : floor + 1;
	} else {
		rounded = Math.round(scaled);
	}
	return rounded / factor;
}

type AggregateArgs = {
	task: string;
};

export function cmdAggregate(args: AggregateArgs): number {
	process.stdout.write(`${JSON.stringify(aggregateTask(args.task), null, 2)}\n`);
	return 0;
}

// ---------- push (ClickUp + Harvest) ----------

async function httpJson(
	method: string,
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown> | null,
): Promise<[number, Record<string, unknown>]> {
	let bodyData: string | undefined;
	let outHeaders: Record<string, string> = headers;
	if (body !== null && body !== undefined) {
		bodyData = JSON.stringify(body);
		outHeaders = { ...headers, "Content-Type": "application/json" };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const resp = await fetch(url, {
			method,
			headers: outHeaders,
			body: bodyData,
			signal: controller.signal,
		});
		const raw = await resp.text();
		if (resp.status >= 400) {
			return [resp.status, { error: raw }];
		}
		if (!raw) {
			return [resp.status, {}];
		}
		try {
			return [resp.status, JSON.parse(raw) as Record<string, unknown>];
		} catch {
			return [resp.status, { raw }];
		}
	} catch (error: unknown) {
		return [0, { error: String(error) }];
	} finally {
		clearTimeout(timer);
	}
}

function clickupPushedPath(task: string): string {
	mkdirSync(TIME_DIR, { recursive: true });
	return path.join(TIME_DIR, `${task}-clickup-pushed.json`);
}

async function pushClickup(
	agg: Aggregate,
	cfg: Record<string, string>,
	dryRun: boolean,
): Promise<Record<string, unknown>> {
	const token = cfg.CLICKUP_TOKEN;
	const team = cfg.CLICKUP_TEAM_ID;
	if (!token || !team) {
		return { skipped: "missing CLICKUP_TOKEN or CLICKUP_TEAM_ID" };
	}
	const totalMs = agg.total_duration_ms;
	if (totalMs <= 0) {
		return { skipped: "zero duration" };
	}

	// Gate applies to dry-run too: refuse to describe a call the operator
	// hasn't authorised. Dry-run only previews the payload once gated open.
	if ((cfg.TRP_ALLOW_REMOTE_MUTATE ?? "").toLowerCase() !== "true") {
		return { refused: "TRP_ALLOW_REMOTE_MUTATE != true" };
	}

	// Idempotency: don't double-post the same task's time.
	const clickupPushedFile = clickupPushedPath(agg.task);
	if (!dryRun && existsSync(clickupPushedFile)) {
		let prior: Record<string, unknown> = {};
		try {
			prior = JSON.parse(readFileSync(clickupPushedFile, "utf8")) as Record<string, unknown>;
		} catch {
			prior = {};
		}
		const eid = prior.entry_id ?? prior.id;
		if (eid) {
			return { skipped: `already pushed (entry_id=${String(eid)})`, prior };
		}
	}

	const stageNames = agg.stages.map((s) => s.name).filter((n): n is string => Boolean(n));
	const summary = stageNames.length > 0 ? stageNames.join(", ") : `${agg.stages.length} stages`;

	const startCandidates: number[] = agg.stages
		.map((s) => s.epoch_start_ms)
		.filter((v): v is number => v !== undefined && v !== null);
	const startVal = startCandidates.length > 0 ? Math.min(...startCandidates) : nowMs() - totalMs;

	const payload: Record<string, unknown> = {
		duration: totalMs,
		start: startVal,
		description: `SRP/SFP/TRP: ${summary} (${agg.sum_hours}h)`,
	};
	const url =
		`https://api.clickup.com/api/v2/task/${agg.task}/time` +
		`?custom_task_ids=true&team_id=${team}`;
	if (dryRun) {
		return { dry_run: true, url, payload };
	}
	const [status, resp] = await httpJson("POST", url, { Authorization: token }, payload);
	const result: Record<string, unknown> = { status, response: resp };
	if (status >= 200 && status < 300 && resp && typeof resp === "object") {
		let data: Record<string, unknown> = resp;
		const inner = (resp as Record<string, unknown>).data;
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			data = inner as Record<string, unknown>;
		}
		const eid = data && typeof data === "object" ? (data as Record<string, unknown>).id : undefined;
		if (eid) {
			const record = {
				entry_id: eid,
				posted_at_epoch_ms: nowMs(),
				duration_ms: totalMs,
			};
			writeFileSync(clickupPushedFile, `${JSON.stringify(record, null, 2)}\n`);
			result.pushed_record = record;
		}
	}
	return result;
}

function speedupNoteSuffix(task: string): string {
	const compPath = path.join(REPO_ROOT, "discovery", "proof", task, "time-comparison.json");
	let isFile = false;
	try {
		isFile = statSync(compPath).isFile();
	} catch {
		return "";
	}
	if (!isFile) {
		return "";
	}
	let comp: Record<string, unknown>;
	try {
		comp = JSON.parse(readFileSync(compPath, "utf8")) as Record<string, unknown>;
	} catch {
		return "";
	}
	const actual = comp.actual_hours;
	const bmin = comp.baseline_min_hours;
	const bmax = comp.baseline_max_hours;
	const smin = comp.speedup_min;
	const smax = comp.speedup_max;
	if (
		actual === null ||
		actual === undefined ||
		bmin === null ||
		bmin === undefined ||
		bmax === null ||
		bmax === undefined ||
		smin === null ||
		smin === undefined ||
		smax === null ||
		smax === undefined
	) {
		return "";
	}
	const totalMin = pyRound(Number(actual) * 60);
	const hm = `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
	return (
		` | AI-assisted actual: ${hm}. Without AI (estimate): ` +
		`${pyRound(Number(bmin))}-${pyRound(Number(bmax))}h. ` +
		`Speedup: ${Number(smin).toFixed(1)}-${Number(smax).toFixed(1)}x.`
	);
}

function pushedPath(task: string, suffix: string = ""): string {
	mkdirSync(TIME_DIR, { recursive: true });
	return path.join(TIME_DIR, `${task}-pushed${suffix}.json`);
}

async function detectClients(task: string): Promise<string[]> {
	const script = path.join(REPO_ROOT, "scripts", "sfp-client-tags.py");
	let isFile = false;
	try {
		isFile = statSync(script).isFile();
	} catch {
		return [];
	}
	if (!isFile) {
		return [];
	}
	let proc: { exitCode: number; stdout: string };
	try {
		proc = await sh("python3", [script, "--sec", task], {
			timeout: 15_000,
			rejectOnError: false,
		});
	} catch {
		return [];
	}
	if (proc.exitCode !== 0) {
		return [];
	}
	const out = (proc.stdout ?? "").trim();
	if (!out) {
		return [];
	}
	return out
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean);
}

function parseProjectMap(raw: string): Record<string, number> {
	if (!raw) {
		return {};
	}
	try {
		const m = JSON.parse(raw) as Record<string, unknown>;
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(m)) {
			const n = Number(v);
			if (!Number.isFinite(n) || Math.trunc(n) !== n) {
				return {};
			}
			out[String(k)] = n;
		}
		return out;
	} catch {
		return {};
	}
}

type HarvestTarget = [string | null, number];

type HarvestTargetResolution = {
	targets: HarvestTarget[];
	clients: string[];
	err: string | null;
	level: string;
};

async function resolveHarvestTargets(
	cfg: Record<string, string>,
	task: string,
): Promise<HarvestTargetResolution> {
	const clients = await detectClients(task);
	if (clients.length === 0) {
		const pid = cfg.HARVEST_TTT_INTERNAL_PROJECT_ID;
		if (!pid) {
			// Legacy fallback: allow a single HARVEST_PROJECT_ID for older configs.
			const legacy = cfg.HARVEST_PROJECT_ID;
			if (legacy) {
				const n = Number(legacy);
				if (Number.isFinite(n) && Math.trunc(n) === n) {
					return { targets: [[null, n]], clients: [], err: null, level: "" };
				}
			}
			return {
				targets: [],
				clients: [],
				err: "no clients detected and HARVEST_TTT_INTERNAL_PROJECT_ID unset",
				level: "ERROR",
			};
		}
		const n = Number(pid);
		if (Number.isFinite(n) && Math.trunc(n) === n) {
			return { targets: [[null, n]], clients: [], err: null, level: "" };
		}
		return {
			targets: [],
			clients: [],
			err: `HARVEST_TTT_INTERNAL_PROJECT_ID not int: '${pid}'`,
			level: "ERROR",
		};
	}

	const pmap = parseProjectMap(cfg.HARVEST_PROJECT_MAP ?? "");
	const missing = clients.filter((c) => !(c in pmap));
	if (missing.length > 0) {
		return {
			targets: [],
			clients,
			err: `clients missing from HARVEST_PROJECT_MAP: [${missing.map((m) => `'${m}'`).join(", ")}]`,
			level: "WARN",
		};
	}

	const strategy = (cfg.HARVEST_MULTI_CLIENT_STRATEGY ?? "split-evenly").toLowerCase();
	if (strategy === "primary-only") {
		const [c] = [...clients].toSorted();
		if (c === undefined) {
			return { targets: [], clients, err: null, level: "" };
		}
		return { targets: [[c, pmap[c] ?? 0]], clients, err: null, level: "" };
	}
	// split-evenly (default)
	const sorted = [...clients].toSorted();
	return {
		targets: sorted.map((c) => [c, pmap[c] ?? 0] as HarvestTarget),
		clients,
		err: null,
		level: "",
	};
}

function harvestHeaders(
	cfg: Record<string, string>,
	tok: string,
	aid: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${tok}`,
		"Harvest-Account-Id": aid,
		"User-Agent": cfg.HARVEST_USER_AGENT ?? "TRP/SRP/SFP time-tracker (operator@example.local)",
	};
}

function renderNote(cfg: Record<string, string>, agg: Aggregate): string {
	const tmpl = cfg.HARVEST_NOTE_TEMPLATE || "{task}: {stages} stages via time-tracker.py{speedup}";
	const stageNames = agg.stages.map((s) => s.name).filter((n): n is string => Boolean(n));
	const stageSummary = stageNames.length > 0 ? stageNames.join(", ") : "";
	const m = /^(SEC-\d+)/u.exec(agg.task || "");
	const secId = m?.[1] ?? (agg.task || "");
	const speedup = speedupNoteSuffix(agg.task);
	const fields: Record<string, string | number> = {
		task: agg.task,
		stages: agg.stages.length,
		hours: agg.sum_hours,
		speedup,
		sec_id: secId,
		stage_summary: stageSummary,
	};
	// Emulate Python str.format(**kwargs): a template referencing an unknown
	// field raises KeyError, so throw here rather than silently emitting the
	// literal `{name}` in the pushed Harvest note — Rule 12, fail loud on a
	// broken template. Identifier pattern matches Python's field-name rule
	// (a letter or underscore followed by word chars), so a template like
	// `{TASK}` fails with KeyError instead of matching nothing.
	return tmpl.replaceAll(/\{([A-Za-z_]\w*)\}/gu, (_full, name: string) => {
		if (!(name in fields)) {
			throw new Error(`KeyError: '${name}'`);
		}
		return String(fields[name]);
	});
}

function todayIso(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatHarvestTime(h: number, m: number): string {
	const suffixAmPm = h < 12 ? "am" : "pm";
	let h12 = h === 12 ? h : h % 12;
	if (h12 === 0) {
		h12 = 12;
	}
	return `${h12}:${String(m).padStart(2, "0")}${suffixAmPm}`;
}

async function pushHarvest(
	agg: Aggregate,
	cfg: Record<string, string>,
	dryRun: boolean,
	verify: boolean = false,
): Promise<Record<string, unknown>> {
	const aid = cfg.HARVEST_ACCOUNT_ID;
	const tok = cfg.HARVEST_ACCESS_TOKEN;
	const tid = cfg.HARVEST_TASK_ID;
	if (!(aid && tok && tid)) {
		return { skipped: "missing HARVEST_{ACCOUNT_ID,ACCESS_TOKEN,TASK_ID}" };
	}
	if (agg.total_duration_ms <= 0) {
		return { skipped: "zero duration" };
	}

	const { targets, clients, err, level } = await resolveHarvestTargets(cfg, agg.task);
	if (err) {
		process.stderr.write(`${level}: skipping Harvest push: ${err}\n`);
		return { skipped: err, level, clients_detected: clients };
	}

	const totalHours = agg.total_duration_ms / 3.6e6;
	const perHours = pyRound(totalHours / targets.length, 4);
	const strategy = (cfg.HARVEST_MULTI_CLIENT_STRATEGY ?? "split-evenly").toLowerCase();
	const url = "https://api.harvestapp.com/v2/time_entries";
	const headersPresent = (cfg.HARVEST_ALLOW_MUTATE ?? "").toLowerCase() === "true";
	const notes = renderNote(cfg, agg);

	const entries: Array<Record<string, unknown>> = await Promise.all(
		targets.map(async ([client, projectId]): Promise<Record<string, unknown>> => {
			const tag = client ?? "ttt-internal";
			const suffix = client !== null || targets.length > 1 ? `-${tag}` : "";
			const pushedPathValue = pushedPath(agg.task, suffix);
			const entry: Record<string, unknown> = {
				client,
				project_id: projectId,
				hours: perHours,
			};

			if (!dryRun && existsSync(pushedPathValue)) {
				let prior: Record<string, unknown> = {};
				try {
					prior = JSON.parse(readFileSync(pushedPathValue, "utf8")) as Record<string, unknown>;
				} catch {
					prior = {};
				}
				if (prior.entry_id) {
					entry.skipped = `already pushed (entry_id=${String(prior.entry_id)})`;
					entry.prior = prior;
					return entry;
				}
			}

			// Harvest accounts in start/end-times mode ignore `hours` and start a
			// zero-duration timer instead. Compute started_time/ended_time from
			// per_hours so the entry has a real duration on both account modes.
			// Anchor at 09:00 local so backdated pushes don't clash with a live
			// workday. `hours` is also sent for accounts that DO accept it -- the
			// start/end pair wins when both are present.
			const startHh = 9;
			const startMm = 0;
			const durMin = pyRound(perHours * 60);
			const endTotal = startHh * 60 + startMm + durMin;
			const endH = Math.floor(endTotal / 60);
			const endM = endTotal % 60;
			const payload: Record<string, unknown> = {
				project_id: projectId,
				task_id: Math.trunc(Number(tid)),
				spent_date: todayIso(),
				hours: perHours,
				started_time: formatHarvestTime(startHh, startMm),
				ended_time: formatHarvestTime(endH, endM),
				notes,
			};
			if (dryRun) {
				entry.dry_run = true;
				entry.url = url;
				entry.payload = payload;
				return entry;
			}
			if (!headersPresent) {
				entry.skipped = "HARVEST_ALLOW_MUTATE != true";
				return entry;
			}

			const headers = harvestHeaders(cfg, tok, aid);
			const [status, resp] = await httpJson("POST", url, headers, payload);
			entry.status = status;
			entry.response = resp;
			if (
				status >= 200 &&
				status < 300 &&
				resp &&
				typeof resp === "object" &&
				(resp as Record<string, unknown>).id
			) {
				const entryId = (resp as Record<string, unknown>).id;
				const record = {
					entry_id: entryId,
					posted_at_epoch_ms: nowMs(),
					hours: payload.hours,
					project_id: projectId,
					client,
				};
				writeFileSync(pushedPathValue, `${JSON.stringify(record, null, 2)}\n`);
				entry.pushed_record = record;
				if (verify) {
					const [vStatus, vResp] = await httpJson(
						"GET",
						`${url}/${String(entryId)}`,
						headers,
						null,
					);
					const fetchedHours =
						vResp && typeof vResp === "object" ? (vResp as Record<string, unknown>).hours : null;
					const fetchedNotes =
						vResp && typeof vResp === "object" ? (vResp as Record<string, unknown>).notes : null;
					const ok =
						vStatus === 200 &&
						fetchedHours !== null &&
						fetchedHours !== undefined &&
						Math.abs(Number(fetchedHours) - Number(payload.hours)) < 1e-4 &&
						fetchedNotes === payload.notes;
					entry.verify = {
						status: vStatus,
						ok,
						fetched_hours: fetchedHours,
						expected_hours: payload.hours,
						notes_match: fetchedNotes === payload.notes,
					};
				}
			}
			return entry;
		}),
	);

	return {
		clients_detected: clients,
		strategy: clients.length > 0 ? strategy : "ttt-internal",
		entries,
	};
}

type PushArgs = {
	task: string;
	dry_run: boolean;
	verify: boolean;
};

export async function cmdPush(args: PushArgs): Promise<number> {
	const cfg = loadConfig();
	const agg = aggregateTask(args.task);
	// Top-level gate: at least one mutation target must be authorised
	// (Harvest or ClickUp), unless this is a dry-run.
	if (!args.dry_run) {
		const harvestOpen = (cfg.HARVEST_ALLOW_MUTATE ?? "").toLowerCase() === "true";
		const clickupOpen = (cfg.TRP_ALLOW_REMOTE_MUTATE ?? "").toLowerCase() === "true";
		if (!(harvestOpen || clickupOpen)) {
			process.stdout.write(
				"refusing: neither HARVEST_ALLOW_MUTATE nor TRP_ALLOW_REMOTE_MUTATE is true\n",
			);
			return 3;
		}
	}
	const out = {
		task: args.task,
		aggregate: agg,
		clickup: await pushClickup(agg, cfg, args.dry_run),
		harvest: await pushHarvest(agg, cfg, args.dry_run, args.verify),
	};
	process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
	return 0;
}

// ---------- compare (vs no-AI baseline) ----------

function cfgFloat(cfg: Record<string, string>, ...keys: string[]): number | null {
	for (const k of keys) {
		const v = cfg[k];
		if (v) {
			const n = Number(v);
			if (Number.isFinite(n)) {
				return n;
			}
		}
	}
	return null;
}

type CompareArgs = {
	task: string;
	mode: string | null;
	cls: string | null;
	advisory_items: number;
	protocol: string | null;
};

function resolveBaselineRange(
	cfg: Record<string, string>,
	args: CompareArgs,
): [number | null, number | null] {
	const protocol = (args.protocol ?? "").toLowerCase();
	const task = args.task ?? "";
	// SRP: explicit protocol=srp or task looks like SEC-\d+
	if (protocol === "srp" || (!protocol && /^SEC-\d+/u.test(task))) {
		return [
			cfgFloat(cfg, "BASELINE_SRP_MIN_HOURS", "BASELINE_SRP_MIN"),
			cfgFloat(cfg, "BASELINE_SRP_MAX_HOURS", "BASELINE_SRP_MAX"),
		];
	}
	if (protocol === "sfp") {
		return [
			cfgFloat(cfg, "BASELINE_SFP_PER_FINDING_MIN"),
			cfgFloat(cfg, "BASELINE_SFP_PER_FINDING_MAX"),
		];
	}
	if (protocol === "trp") {
		const mode = (args.mode ?? "").toUpperCase();
		const cls = (args.cls ?? "").toUpperCase();
		if (mode === "SOLVE" && cls) {
			return [
				cfgFloat(cfg, `BASELINE_TRP_SOLVE_${cls}_MIN`),
				cfgFloat(cfg, `BASELINE_TRP_SOLVE_${cls}_MAX`),
			];
		}
		if (mode) {
			return [cfgFloat(cfg, `BASELINE_TRP_${mode}_MIN`), cfgFloat(cfg, `BASELINE_TRP_${mode}_MAX`)];
		}
	}
	return [null, null];
}

function countAttempts(task: string): number {
	let n = 0;
	for (const _ of iterSessionsFor(task)) {
		n += 1;
	}
	return n;
}

export function cmdCompare(args: CompareArgs): number {
	const cfg = loadConfig();
	const agg = aggregateTask(args.task);
	const actual = agg.sum_hours;

	let [baseMin, baseMax] = resolveBaselineRange(cfg, args);

	// Advisory-item scaling: srp OR trp-solve, when advisory_items > 1
	let protocol = (args.protocol ?? "").toLowerCase();
	if (!protocol && /^SEC-\d+/u.test(args.task ?? "")) {
		protocol = "srp";
	}
	const mode = (args.mode ?? "").toLowerCase();
	const scaleEligible = protocol === "srp" || (protocol === "trp" && mode === "solve");
	if (args.advisory_items && args.advisory_items > 1 && scaleEligible && baseMin && baseMax) {
		const mult = cfgFloat(cfg, "BASELINE_ADVISORY_ITEM_MULTIPLIER") ?? 1.5;
		// Divides by 3 so single-item bundles stay at base; scales on multi-item.
		baseMin = (baseMin * mult * args.advisory_items) / 3;
		baseMax = (baseMax * mult * args.advisory_items) / 3;
	}

	const result: Record<string, unknown> = {
		task: args.task,
		protocol: protocol || null,
		actual_hours: pyRound(actual, 4),
		baseline_min_hours: baseMin === null ? null : pyRound(baseMin, 4),
		baseline_max_hours: baseMax === null ? null : pyRound(baseMax, 4),
		attempts: countAttempts(args.task),
		note: "Sum across REVISE-loop attempts. Baseline stays fixed.",
	};
	if (baseMin !== null && baseMax !== null && actual > 0) {
		result.speedup_min = pyRound(baseMin / actual, 4);
		result.speedup_max = pyRound(baseMax / actual, 4);
	} else {
		result.speedup_min = null;
		result.speedup_max = null;
		if (actual <= 0) {
			result.warning = "no actual duration recorded";
		} else if (baseMin === null) {
			result.warning = "no baseline resolved for protocol/mode/class (check baselines.env)";
		}
	}

	const outDir = path.join(REPO_ROOT, "discovery", "proof", args.task);
	mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, "time-comparison.json");
	writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	return 0;
}

// ---------- arg parsing ----------

type ParsedArgs = {
	cmd: string;
	// start/stop/aggregate/push/compare merged args
	task?: string;
	stage?: string;
	note?: string | null;
	dry_run?: boolean;
	verify?: boolean;
	mode?: string | null;
	cls?: string | null;
	advisory_items?: number;
	protocol?: string | null;
};

class ArgError extends Error {}

function takeValue(argv: string[], i: number, flag: string): [string, number] {
	const arg = argv[i];
	if (arg === undefined) {
		throw new ArgError(`argument ${flag}: expected one argument`);
	}
	if (arg.includes("=")) {
		return [arg.slice(arg.indexOf("=") + 1), i + 1];
	}
	if (i + 1 >= argv.length) {
		throw new ArgError(`argument ${flag}: expected one argument`);
	}
	const next = argv[i + 1];
	if (next === undefined) {
		throw new ArgError(`argument ${flag}: expected one argument`);
	}
	return [next, i + 2];
}

function argFlagName(a: string): string {
	return a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
}

export function parseArgs(argv: string[]): ParsedArgs {
	if (argv.length === 0) {
		throw new ArgError("the following arguments are required: cmd");
	}
	const [cmd] = argv;
	if (cmd === undefined) {
		throw new ArgError("the following arguments are required: cmd");
	}
	const rest = argv.slice(1);
	const out: ParsedArgs = { cmd };

	if (cmd === "start") {
		let i = 0;
		while (i < rest.length) {
			const a = rest[i];
			if (a === undefined) {
				break;
			}
			const name = argFlagName(a);
			if (name === "--task") {
				const [v, next] = takeValue(rest, i, "--task");
				out.task = v;
				i = next;
			} else if (name === "--stage") {
				const [v, next] = takeValue(rest, i, "--stage");
				out.stage = v;
				i = next;
			} else {
				throw new ArgError(`unrecognized arguments: ${a}`);
			}
		}
		if (!out.task) {
			throw new ArgError("the following arguments are required: --task");
		}
		if (!out.stage) {
			throw new ArgError("the following arguments are required: --stage");
		}
	} else if (cmd === "stop") {
		out.note = null;
		let i = 0;
		while (i < rest.length) {
			const a = rest[i];
			if (a === undefined) {
				break;
			}
			const name = argFlagName(a);
			if (name === "--task") {
				const [v, next] = takeValue(rest, i, "--task");
				out.task = v;
				i = next;
			} else if (name === "--stage") {
				const [v, next] = takeValue(rest, i, "--stage");
				out.stage = v;
				i = next;
			} else if (name === "--note") {
				const [v, next] = takeValue(rest, i, "--note");
				out.note = v;
				i = next;
			} else {
				throw new ArgError(`unrecognized arguments: ${a}`);
			}
		}
		if (!out.task) {
			throw new ArgError("the following arguments are required: --task");
		}
		if (!out.stage) {
			throw new ArgError("the following arguments are required: --stage");
		}
	} else if (cmd === "aggregate") {
		let i = 0;
		while (i < rest.length) {
			const a = rest[i];
			if (a === undefined) {
				break;
			}
			const name = argFlagName(a);
			if (name === "--task") {
				const [v, next] = takeValue(rest, i, "--task");
				out.task = v;
				i = next;
			} else {
				throw new ArgError(`unrecognized arguments: ${a}`);
			}
		}
		if (!out.task) {
			throw new ArgError("the following arguments are required: --task");
		}
	} else if (cmd === "push") {
		out.dry_run = false;
		out.verify = false;
		let i = 0;
		while (i < rest.length) {
			const a = rest[i];
			if (a === undefined) {
				break;
			}
			const name = argFlagName(a);
			if (name === "--task") {
				const [v, next] = takeValue(rest, i, "--task");
				out.task = v;
				i = next;
			} else if (name === "--dry-run") {
				out.dry_run = true;
				i += 1;
			} else if (name === "--verify") {
				out.verify = true;
				i += 1;
			} else {
				throw new ArgError(`unrecognized arguments: ${a}`);
			}
		}
		if (!out.task) {
			throw new ArgError("the following arguments are required: --task");
		}
	} else if (cmd === "compare") {
		out.mode = null;
		out.cls = null;
		out.advisory_items = 1;
		out.protocol = null;
		let i = 0;
		while (i < rest.length) {
			const a = rest[i];
			if (a === undefined) {
				break;
			}
			const name = argFlagName(a);
			if (name === "--task") {
				const [v, next] = takeValue(rest, i, "--task");
				out.task = v;
				i = next;
			} else if (name === "--mode") {
				const [v, next] = takeValue(rest, i, "--mode");
				out.mode = v;
				i = next;
			} else if (name === "--class") {
				const [v, next] = takeValue(rest, i, "--class");
				out.cls = v;
				i = next;
			} else if (name === "--advisory-items") {
				const [v, next] = takeValue(rest, i, "--advisory-items");
				out.advisory_items = Math.trunc(Number(v));
				i = next;
			} else if (name === "--protocol") {
				const [v, next] = takeValue(rest, i, "--protocol");
				if (!["srp", "trp", "sfp"].includes(v)) {
					throw new ArgError(
						`argument --protocol: invalid choice: '${v}' (choose from 'srp', 'trp', 'sfp')`,
					);
				}
				out.protocol = v;
				i = next;
			} else {
				throw new ArgError(`unrecognized arguments: ${a}`);
			}
		}
		if (!out.task) {
			throw new ArgError("the following arguments are required: --task");
		}
	} else {
		throw new ArgError(
			`argument cmd: invalid choice: '${cmd}' (choose from 'start', 'stop', 'aggregate', 'push', 'compare')`,
		);
	}
	return out;
}

export async function main(argv: string[] | null = null): Promise<number> {
	const rawArgv = argv ?? process.argv.slice(2);
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(rawArgv);
	} catch (error: unknown) {
		if (error instanceof ArgError) {
			process.stderr.write(`time-tracker.py: error: ${error.message}\n`);
			return 2;
		}
		throw error;
	}
	switch (parsed.cmd) {
		case "start": {
			return cmdStart({ task: parsed.task ?? "", stage: parsed.stage ?? "" });
		}
		case "stop": {
			return cmdStop({
				task: parsed.task ?? "",
				stage: parsed.stage ?? "",
				note: parsed.note ?? null,
			});
		}
		case "aggregate": {
			return cmdAggregate({ task: parsed.task ?? "" });
		}
		case "push": {
			return await cmdPush({
				task: parsed.task ?? "",
				dry_run: parsed.dry_run ?? false,
				verify: parsed.verify ?? false,
			});
		}
		case "compare": {
			return cmdCompare({
				task: parsed.task ?? "",
				mode: parsed.mode ?? null,
				cls: parsed.cls ?? null,
				advisory_items: parsed.advisory_items ?? 1,
				protocol: parsed.protocol ?? null,
			});
		}
		default: {
			return 2;
		}
	}
}

// Only run main() when this file is invoked directly (not on test import).
function isDirectRun(): boolean {
	const [, entry] = process.argv;
	if (!entry) {
		return false;
	}
	try {
		return import.meta.filename === entry || import.meta.url === `file://${entry}`;
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		const code = await main();
		process.exit(code);
	} catch (error: unknown) {
		process.stderr.write(`time-tracker: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
