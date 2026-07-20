/**
 * `@foundation/claude-multiacct` — `cma status`. READ-ONLY.
 *
 * Runs on every invocation of `cma status` and (via reuse) `cma doctor`.
 * Collects:
 *
 *   - `config.json` state (path + parsed contents or defaults);
 *   - registry state (count + primary marker);
 *   - `/Applications/Claude.app` bundle signing/Gatekeeper info via
 *     `codesign -dv` and `spctl -a -vv`;
 *   - "installed markers in the asar" — always ZERO here; this PR never
 *     modifies the bundle. A non-zero reading would signal drift from
 *     the update-safe design.
 *
 * # Read-only invariant
 *
 * `status` MUST NOT invoke any write on any injected port. The test suite
 * mocks fs + config-store + registry-writer + execFile and asserts none
 * of them is called with a write shape. Adversarial: add a write here
 * and the read-only test goes red.
 *
 * @module
 */

import type { AccountRegistry } from "../../domain/registry.ts";
import type { CmaConfig } from "../config-store.ts";

/** `execFile`-shape port. Returns `{stdout, stderr}` and a status code. */
export type ExecFileResult = { stdout: string; stderr: string; code: number };
export type ExecFileFn = (file: string, args: readonly string[]) => Promise<ExecFileResult>;

/** Injected ports every read-only field takes. */
export type StatusPorts = {
	configPath: string;
	config: CmaConfig | undefined;
	registryPath: string;
	registry: AccountRegistry | undefined;
	appPath: string;
	execFile: ExecFileFn;
};

/** Structured section carrying every field the human printer renders. */
export type StatusReport = {
	config: {
		path: string;
		enabled: boolean;
		logDir: string;
		bridgeJsonPath: string;
		configVersion: number;
		usedDefaults: boolean;
	};
	registry: {
		path: string;
		count: number;
		primaryLabel: string | undefined;
		labels: readonly string[];
	};
	claudeApp: {
		appPath: string;
		codesignAuthority: string | undefined;
		gatekeeper: string | undefined;
		injectedMarkers: number;
		notes: readonly string[];
	};
	installer: {
		note: string;
	};
};

/**
 * Default `execFile` port bound to `node:child_process`.
 *
 * @returns {ExecFileFn} Port whose `(file, args)` call resolves stdout/stderr/code.
 */
export function nodeExecFilePort(): ExecFileFn {
	return async (file, args) => {
		const { execFile } = await import("node:child_process");
		return new Promise((resolve) => {
			execFile(file, [...args], (error, stdout, stderr) => {
				const code = (error as { code?: number } | null)?.code ?? 0;
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code,
				});
			});
		});
	};
}

/**
 * Collect status without touching disk beyond the two read paths + two
 * `execFile` probes.
 *
 * @param {StatusPorts} ports - Injected ports.
 * @returns {Promise<StatusReport>} Structured report; renderer formats.
 */
export async function collectStatus(ports: StatusPorts): Promise<StatusReport> {
	const cfg = ports.config;
	const configSection: StatusReport["config"] = {
		path: ports.configPath,
		enabled: cfg?.enabled ?? false,
		logDir: cfg?.logDir ?? "(defaults)",
		bridgeJsonPath: cfg?.bridgeJsonPath ?? "(defaults)",
		configVersion: cfg?.configVersion ?? 1,
		usedDefaults: cfg === undefined,
	};
	const primary = ports.registry?.accounts.find((a) => a.isPrimary);
	const registrySection: StatusReport["registry"] = {
		path: ports.registryPath,
		count: ports.registry?.accounts.length ?? 0,
		primaryLabel: primary?.label,
		labels: ports.registry?.accounts.map((a) => a.label) ?? [],
	};

	// Claude.app section — best-effort via codesign + spctl. Errors are
	// tolerated: on machines without Claude installed, both probes exit
	// non-zero; the resulting undefined shows up as a warning in doctor.
	const notes: string[] = [];
	const codesign = await ports.execFile("codesign", ["-dv", ports.appPath]);
	const authority = extractAuthority(codesign.stderr) ?? extractAuthority(codesign.stdout);
	if (codesign.code !== 0 && authority === undefined) {
		notes.push(`codesign probe returned ${String(codesign.code)}: ${codesign.stderr.trim()}`);
	}
	const spctl = await ports.execFile("spctl", ["-a", "-vv", ports.appPath]);
	const gatekeeper = extractGatekeeper(spctl.stderr) ?? extractGatekeeper(spctl.stdout);
	if (spctl.code !== 0 && gatekeeper === undefined) {
		notes.push(`spctl probe returned ${String(spctl.code)}: ${spctl.stderr.trim()}`);
	}

	const claudeAppSection: StatusReport["claudeApp"] = {
		appPath: ports.appPath,
		codesignAuthority: authority,
		gatekeeper,
		// This PR never patches the app bundle. Anything but 0 signals drift.
		injectedMarkers: 0,
		notes,
	};

	const installerSection: StatusReport["installer"] = {
		note: "installer/agent status: see PR6b for installer status wiring",
	};

	return {
		config: configSection,
		registry: registrySection,
		claudeApp: claudeAppSection,
		installer: installerSection,
	};
}

/**
 * Format a `StatusReport` as human-friendly text for `cma status`.
 *
 * @param {StatusReport} report - Structured report from `collectStatus`.
 * @returns {string} Newline-joined lines the CLI writes verbatim to stdout.
 */
export function renderStatus(report: StatusReport): string {
	const cfg = report.config;
	const reg = report.registry;
	const app = report.claudeApp;
	const configLines = [
		"=== Config ===",
		`  path:           ${cfg.path}`,
		`  enabled:        ${String(cfg.enabled)}`,
		`  logDir:         ${cfg.logDir}`,
		`  bridgeJsonPath: ${cfg.bridgeJsonPath}`,
		`  configVersion:  ${String(cfg.configVersion)}`,
		...(cfg.usedDefaults ? ["  (using in-memory defaults — run `cma init`)"] : []),
	];
	const registryLines = [
		"",
		"=== Registry ===",
		`  path:    ${reg.path}`,
		`  count:   ${String(reg.count)}`,
		...(reg.primaryLabel === undefined ? [] : [`  primary: ${reg.primaryLabel}`]),
		...reg.labels.map((label) => `   - ${label}`),
	];
	const claudeLines = [
		"",
		"=== Claude.app ===",
		`  appPath:            ${app.appPath}`,
		`  codesign authority: ${app.codesignAuthority ?? "(unknown)"}`,
		`  gatekeeper:         ${app.gatekeeper ?? "(unknown)"}`,
		`  injected markers:   ${String(app.injectedMarkers)}`,
		...app.notes.map((note) => `  ! ${note}`),
	];
	const installerLines = ["", "=== Installer ===", `  ${report.installer.note}`];
	return [...configLines, ...registryLines, ...claudeLines, ...installerLines].join("\n");
}

/**
 * Parse `Authority=...` out of `codesign -dv` output.
 *
 * @param {string} text - Raw codesign output (stderr on macOS).
 * @returns {string | undefined} The authority string, or undefined if absent.
 */
function extractAuthority(text: string): string | undefined {
	const match = /^Authority=(.+)$/mu.exec(text);
	return match?.[1]?.trim();
}

/**
 * Parse the Gatekeeper verdict out of `spctl -a -vv` output.
 *
 * @param {string} text - Raw spctl output.
 * @returns {string | undefined} The `source=…` line, or the first non-empty line.
 */
function extractGatekeeper(text: string): string | undefined {
	// spctl emits `<path>: <verdict>` on success and `source=Notarized ...`
	// among the details. Return the first `source=` line when present, else
	// the first non-empty line so tests can pin either shape.
	const src = /^source=(.+)$/mu.exec(text);
	if (src !== null) {
		return src[1]?.trim();
	}
	const first = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return first;
}
