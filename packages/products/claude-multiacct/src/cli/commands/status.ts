/**
 * `@foundation/claude-multiacct` — `cma status`. READ-ONLY.
 *
 * Runs on every invocation of `cma status` and (via reuse) `cma doctor`.
 * Collects:
 *
 *   - `config.json` state (path + parsed contents or defaults);
 *   - registry state (account count + labels);
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

/**
 * Per-subsystem installer status collected by `cma status`. Each field is
 * a self-classified summary — the doctor uses `ok`/`warn`/`error` markers
 * as-is. Bug 7 in PR6b live retry: this section used to hold a placeholder
 * ("see PR6b for installer status wiring"); the real installers ship in
 * PR2/PR3/PR5a/PR5b and their `status()` fns are what we invoke here.
 */
export type InstallerStatusReport = {
	shim: {
		/** Per-CLI-dir shim install state (one entry per detected version). */
		perCliDir: ReadonlyArray<{
			cliDir: string;
			installed: boolean;
			hasShim: boolean;
			hasReal: boolean;
		}>;
	};
	watcher: {
		plistPath: string;
		plistExists: boolean;
		loaded: boolean;
	};
	daemon: {
		plistPath: string;
		plistExists: boolean;
		loaded: boolean;
		bridgeJsonExists: boolean;
		bridgeJsonPidAlive: boolean | undefined;
	};
	extension: {
		installed: boolean;
		files: readonly string[];
		symlinkValid: boolean;
	};
};

/** Injected port that returns real installer status. See `InstallerStatusReport`. */
export type InstallerStatusFn = () => Promise<InstallerStatusReport>;

/** Injected ports every read-only field takes. */
export type StatusPorts = {
	configPath: string;
	config: CmaConfig | undefined;
	registryPath: string;
	registry: AccountRegistry | undefined;
	appPath: string;
	execFile: ExecFileFn;
	/** Bug 7 (PR6b live retry): required. Was a placeholder note; wired now. */
	installerStatus: InstallerStatusFn;
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
		labels: readonly string[];
	};
	claudeApp: {
		appPath: string;
		codesignAuthority: string | undefined;
		gatekeeper: string | undefined;
		injectedMarkers: number;
		notes: readonly string[];
	};
	installer: InstallerStatusReport;
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
	const registrySection: StatusReport["registry"] = {
		path: ports.registryPath,
		count: ports.registry?.accounts.length ?? 0,
		labels: ports.registry?.accounts.map((a) => a.label) ?? [],
	};

	// Claude.app section — best-effort via codesign + spctl. Errors are
	// tolerated: on machines without Claude installed, both probes exit
	// non-zero; the resulting undefined shows up as a warning in doctor.
	const notes: string[] = [];
	// `-dvv` (NOT `-dv`) — `-dv` prints Executable/Identifier/Format/… but no
	// `Authority=` lines. The Authority chain only appears at verbosity level
	// 2+. This was Bug 6 in the PR6b live retry: shell showed the info, but
	// the doctor reported `could not read code signature` because the parser
	// looked for a line codesign never emits at `-dv`.
	const codesign = await ports.execFile("codesign", ["-dvv", ports.appPath]);
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

	// Real installer statuses from PR2 (shim) + PR3 (watcher) + PR5a
	// (daemon) + PR5b (extension). Bug 7 (PR6b live retry) fix: was a
	// placeholder string; the installers' status() fns are what this
	// section carries. dispatch.ts wires the concrete port; tests inject
	// a fake so every subsystem is invocation-covered.
	const installerSection: StatusReport["installer"] = await ports.installerStatus();

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
	const inst = report.installer;
	const shimLines = [
		"",
		"=== Installer: shim (PR2) ===",
		`  cli dirs: ${String(inst.shim.perCliDir.length)}`,
		...inst.shim.perCliDir.map(
			(d) =>
				`   - ${d.cliDir}: installed=${String(d.installed)} hasShim=${String(d.hasShim)} hasReal=${String(d.hasReal)}`,
		),
	];
	const watcherLines = [
		"",
		"=== Installer: watcher (PR3) ===",
		`  plistPath:    ${inst.watcher.plistPath}`,
		`  plistExists:  ${String(inst.watcher.plistExists)}`,
		`  loaded:       ${String(inst.watcher.loaded)}`,
	];
	const daemonLines = [
		"",
		"=== Installer: bridge daemon (PR5a) ===",
		`  plistPath:         ${inst.daemon.plistPath}`,
		`  plistExists:       ${String(inst.daemon.plistExists)}`,
		`  loaded:            ${String(inst.daemon.loaded)}`,
		`  bridgeJsonExists:  ${String(inst.daemon.bridgeJsonExists)}`,
		`  bridgeJsonPidAlive: ${
			inst.daemon.bridgeJsonPidAlive === undefined
				? "(unknown)"
				: String(inst.daemon.bridgeJsonPidAlive)
		}`,
	];
	const extensionLines = [
		"",
		"=== Installer: extension (PR5b) ===",
		`  installed:     ${String(inst.extension.installed)}`,
		`  symlinkValid:  ${String(inst.extension.symlinkValid)}`,
		...inst.extension.files.map((f) => `   - ${f}`),
	];
	return [
		...configLines,
		...registryLines,
		...claudeLines,
		...shimLines,
		...watcherLines,
		...daemonLines,
		...extensionLines,
	].join("\n");
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
