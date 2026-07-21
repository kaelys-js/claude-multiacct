/**
 * `@foundation/claude-multiacct` — `cma doctor`.
 *
 * Runs the same read-only data collection as `cma status`, then classifies
 * each field into `ok` / `warn` / `error` and prints a short fix hint for
 * anything that isn't `ok`. Read-only — same discipline as `status`; the
 * tests assert zero writes across every injected port.
 *
 * @module
 */

import { type StatusPorts, type StatusReport, collectStatus } from "./status.ts";

/** Classification tier. */
export type Tier = "ok" | "warn" | "error";

/** One line of the doctor's output. */
export type DoctorFinding = {
	label: string;
	tier: Tier;
	message: string;
	fix?: string;
};

/**
 * Run the status collector, then classify each field. Read-only.
 *
 * @param {StatusPorts} ports - Injected ports.
 * @returns {Promise<{report: StatusReport, findings: DoctorFinding[]}>} Findings.
 */
export async function collectDoctor(ports: StatusPorts): Promise<{
	report: StatusReport;
	findings: DoctorFinding[];
}> {
	const report = await collectStatus(ports);
	const findings: DoctorFinding[] = [];

	// Config
	if (report.config.usedDefaults) {
		findings.push({
			label: "config.json",
			tier: "warn",
			message: "no config file on disk; using in-memory defaults",
			fix: "run `cma init` to create ~/.config/claude-multiacct/config.json",
		});
	} else {
		findings.push({
			label: "config.json",
			tier: "ok",
			message: `enabled=${String(report.config.enabled)}`,
		});
	}

	// Registry
	if (report.registry.count === 0) {
		findings.push({
			label: "registry",
			tier: "warn",
			message: "no accounts configured",
			fix: "run `cma account add --label=<name>` to add one",
		});
	} else if (report.registry.primaryLabel === undefined) {
		findings.push({
			label: "registry",
			tier: "error",
			message: "no primary account (invariant violation)",
			fix: "run `cma account set-primary --label=<one>` to elect a primary",
		});
	} else {
		findings.push({
			label: "registry",
			tier: "ok",
			message: `${String(report.registry.count)} account(s), primary=${report.registry.primaryLabel}`,
		});
	}

	// Claude.app
	if (report.claudeApp.codesignAuthority === undefined) {
		findings.push({
			label: "Claude.app codesign",
			tier: "error",
			message: "could not read code signature",
			fix: `install Claude Desktop from https://claude.ai/download and confirm ${report.claudeApp.appPath} exists`,
		});
	} else {
		findings.push({
			label: "Claude.app codesign",
			tier: "ok",
			message: report.claudeApp.codesignAuthority,
		});
	}
	if (report.claudeApp.gatekeeper === undefined) {
		findings.push({
			label: "Claude.app gatekeeper",
			tier: "warn",
			message: "spctl verdict unavailable",
		});
	} else {
		findings.push({
			label: "Claude.app gatekeeper",
			tier: "ok",
			message: report.claudeApp.gatekeeper,
		});
	}
	// `injectedMarkers` is always 0 in PR6a (bundle is never touched); the
	// field exists so PR6b can wire the drift check without changing the
	// StatusReport shape. Classifier for that case lands with PR6b.

	return { report, findings };
}

/**
 * Format a doctor result as text.
 *
 * @param {readonly DoctorFinding[]} findings - Classified findings.
 * @returns {string} Newline-joined output the CLI writes verbatim.
 */
export function renderDoctor(findings: readonly DoctorFinding[]): string {
	return findings
		.flatMap((f) => {
			const tag = tierTag(f.tier);
			const first = `${tag}  ${f.label}: ${f.message}`;
			return f.fix === undefined ? [first] : [first, `         fix: ${f.fix}`];
		})
		.join("\n");
}

/**
 * Map a `Tier` to its render tag.
 *
 * @param {Tier} tier - Finding tier.
 * @returns {string} Column-aligned prefix.
 */
function tierTag(tier: Tier): string {
	if (tier === "ok") {
		return "  ok  ";
	}
	if (tier === "warn") {
		return "  WARN";
	}
	return " ERROR";
}
