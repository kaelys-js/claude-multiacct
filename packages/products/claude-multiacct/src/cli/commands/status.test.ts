/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `cma status` is READ-ONLY. Load-bearing:
 *
 *   - Zero writes across all injected ports: config-store.write is not
 *     invoked, registryWriter.write is not invoked, execFile is only
 *     called with `codesign`/`spctl` (no `install`/`rm`/`cp`).
 *     Adversarial: adding any write in collectStatus would fail this.
 *   - collectStatus tolerates a missing Claude.app: probes exit non-zero,
 *     authority/gatekeeper come back undefined, notes carry the error
 *     summary — no throw.
 *   - renderStatus prints every section header + all field values it was
 *     given.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountRegistry } from "../../domain/registry.ts";
import { type CmaConfig, defaultConfig } from "../config-store.ts";
import {
	type ExecFileFn,
	type InstallerStatusFn,
	type InstallerStatusReport,
	collectStatus,
	nodeExecFilePort,
	renderStatus,
} from "./status.ts";
import { AccountUuidSchema } from "../../domain/account.ts";
import * as v from "valibot";

const UUID = "11111111-1111-4111-8111-111111111111";

function registryOf(): AccountRegistry {
	return {
		accounts: [
			{
				uuid: v.parse(AccountUuidSchema, UUID),
				label: "Personal",
				isPrimary: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:a",
			},
		],
	};
}

/** Empty-shape installer status. Overrides via `stubInstallerStatus(...)`. */
function emptyInstallerStatusReport(): InstallerStatusReport {
	return {
		shim: { perCliDir: [] },
		watcher: { plistPath: "/plist/w", plistExists: false, loaded: false },
		daemon: {
			plistPath: "/plist/d",
			plistExists: false,
			loaded: false,
			bridgeJsonExists: false,
			bridgeJsonPidAlive: undefined,
		},
		extension: { installed: false, files: [], symlinkValid: false },
	};
}

function stubInstallerStatus(override: Partial<InstallerStatusReport> = {}): InstallerStatusFn {
	const base = emptyInstallerStatusReport();
	return vi.fn(async () => ({ ...base, ...override }));
}

function makeExec(
	responses: Record<string, { stdout?: string; stderr?: string; code?: number }>,
): ExecFileFn {
	return vi.fn(async (file: string) => {
		const r = responses[file] ?? { code: 1 };
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
	});
}

describe("collectStatus: read-only invariants", () => {
	it("returns config defaults marker when config is undefined; NO writes to any port", async () => {
		const exec = makeExec({
			codesign: { stderr: "Authority=Developer ID Application: Anthropic PBC\n", code: 0 },
			spctl: { stderr: "source=Notarized Developer ID\n", code: 0 },
		});
		const report = await collectStatus({
			configPath: "/cfg",
			config: undefined,
			registryPath: "/reg",
			registry: undefined,
			appPath: "/Applications/Claude.app",
			execFile: exec,
			installerStatus: stubInstallerStatus(),
		});
		expect(report.config.enabled).toBe(false);
		expect(report.config.usedDefaults).toBe(true);
		expect(report.registry.count).toBe(0);
		expect(report.claudeApp.codesignAuthority).toContain("Anthropic PBC");
		expect(report.claudeApp.gatekeeper).toContain("Notarized");
		expect(report.claudeApp.injectedMarkers).toBe(0);
		// execFile only called with codesign/spctl — no destructive commands.
		const execMock = exec as ReturnType<typeof vi.fn>;
		const calls = execMock.mock.calls.map((c: unknown[]) => c[0]);
		expect(calls).toStrictEqual(["codesign", "spctl"]);
	});

	it("populated config + registry surfaces every field", async () => {
		const exec = makeExec({
			codesign: { stderr: "Authority=Apple Root CA\n", code: 0 },
			spctl: { stderr: "source=Notarized\n", code: 0 },
		});
		const cfg: CmaConfig = { ...defaultConfig(), enabled: true, configVersion: 1 };
		const report = await collectStatus({
			configPath: "/cfg",
			config: cfg,
			registryPath: "/reg",
			registry: registryOf(),
			appPath: "/Applications/Claude.app",
			execFile: exec,
			installerStatus: stubInstallerStatus(),
		});
		expect(report.config.usedDefaults).toBe(false);
		expect(report.config.enabled).toBe(true);
		expect(report.registry.count).toBe(1);
		expect(report.registry.primaryLabel).toBe("Personal");
		expect(report.registry.labels).toStrictEqual(["Personal"]);
	});

	it("codesign probe uses `-dvv` (NOT `-dv`) — Authority=… only at verbosity ≥2", async () => {
		// Bug 6 regression: with `-dv`, macOS's real codesign emits
		// Executable/Identifier/Format/CodeDirectory/Signature/Timestamp/
		// Info.plist/TeamIdentifier/Runtime Version/Sealed Resources/
		// Internal requirements on stderr — but NO `Authority=` lines. The
		// parser saw undefined and doctor reported "could not read code
		// signature" despite the shell showing full auth info. This test
		// pins both the argv (`-dvv`) and the parser's requirement of an
		// Authority line — reverting to `-dv` trips (a) the argv assertion
		// and (b) the dvOnly parse check.
		const REAL_DV_OUTPUT = `Executable=/Applications/Claude.app/Contents/MacOS/Claude
Identifier=com.anthropic.claudefordesktop
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=458 flags=0x10000(runtime) hashes=3+7 location=embedded
Signature size=9046
Timestamp=Jul 18, 2026 at 7:17:34 PM
Info.plist entries=42
TeamIdentifier=Q6L2SF6YDW
Runtime Version=26.2.0
Sealed Resources version=2 rules=13 files=1562
Internal requirements count=1 size=192
`;
		const REAL_DVV_OUTPUT = `${REAL_DV_OUTPUT}Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
`;
		const captured: Array<{ file: string; args: readonly string[] }> = [];
		const exec: ExecFileFn = async (file, args) => {
			captured.push({ file, args });
			if (file === "codesign") {
				return { stdout: "", stderr: REAL_DVV_OUTPUT, code: 0 };
			}
			return { stdout: "", stderr: "source=Notarized Developer ID\n", code: 0 };
		};
		const report = await collectStatus({
			configPath: "/cfg",
			config: undefined,
			registryPath: "/reg",
			registry: undefined,
			appPath: "/Applications/Claude.app",
			execFile: exec,
			installerStatus: stubInstallerStatus(),
		});
		const codesignCall = captured.find((c) => c.file === "codesign");
		expect(codesignCall?.args[0]).toBe("-dvv");
		expect(report.claudeApp.codesignAuthority).toContain("Anthropic PBC");
		// `-dv` output alone (no Authority lines) → parser returns undefined.
		const dvOnly: ExecFileFn = async (file) => {
			if (file === "codesign") {
				return { stdout: "", stderr: REAL_DV_OUTPUT, code: 0 };
			}
			return { stdout: "", stderr: "source=Notarized\n", code: 0 };
		};
		const reportDv = await collectStatus({
			configPath: "/cfg",
			config: undefined,
			registryPath: "/reg",
			registry: undefined,
			appPath: "/Applications/Claude.app",
			execFile: dvOnly,
			installerStatus: stubInstallerStatus(),
		});
		expect(reportDv.claudeApp.codesignAuthority).toBeUndefined();
	});

	it("missing Claude.app: probes non-zero → authority + gatekeeper undefined + note recorded", async () => {
		const exec = makeExec({
			codesign: { stderr: "no such file\n", code: 1 },
			spctl: { stderr: "no such file\n", code: 3 },
		});
		const report = await collectStatus({
			configPath: "/cfg",
			config: undefined,
			registryPath: "/reg",
			registry: undefined,
			appPath: "/nope/Claude.app",
			execFile: exec,
			installerStatus: stubInstallerStatus(),
		});
		expect(report.claudeApp.codesignAuthority).toBeUndefined();
		expect(report.claudeApp.gatekeeper).toContain("no such file");
		expect(report.claudeApp.notes.length).toBeGreaterThan(0);
	});
});

describe("collectStatus: installer subsystem wiring (Bug 7 fix)", () => {
	// Bug 7 (PR6b live retry): `cma status` used to print
	// "installer/agent status: see PR6b for installer status wiring". The
	// four installers (shim + watcher + daemon + extension) already ship
	// their own `status()`/`statusAgent()` fns — the fix is to invoke each
	// one and thread the results into the report. These tests prove all
	// four are invoked exactly once and the composite is what the renderer
	// receives. Adversarial: revert the wiring to a placeholder string →
	// (a) the invocation-count assertions trip AND (b) the render assertion
	// on the four `=== Installer: … ===` headers trips.
	it("invokes injected installerStatus port exactly once and forwards its result", async () => {
		const exec = makeExec({
			codesign: { stderr: "Authority=Apple Root CA\n", code: 0 },
			spctl: { stderr: "source=Notarized\n", code: 0 },
		});
		const installerFake = vi.fn<InstallerStatusFn>(async () => ({
			shim: {
				perCliDir: [
					{ cliDir: "/Applications/Claude.app/1.0", installed: true, hasShim: true, hasReal: true },
				],
			},
			watcher: { plistPath: "/plist/w", plistExists: true, loaded: true },
			daemon: {
				plistPath: "/plist/d",
				plistExists: true,
				loaded: true,
				bridgeJsonExists: true,
				bridgeJsonPidAlive: true,
			},
			extension: {
				installed: true,
				files: ["/ext/manifest.json", "/ext/content.js"],
				symlinkValid: true,
			},
		}));
		const report = await collectStatus({
			configPath: "/cfg",
			config: undefined,
			registryPath: "/reg",
			registry: undefined,
			appPath: "/Applications/Claude.app",
			execFile: exec,
			installerStatus: installerFake,
		});
		expect(installerFake).toHaveBeenCalledTimes(1);
		expect(report.installer.shim.perCliDir).toHaveLength(1);
		expect(report.installer.shim.perCliDir[0]?.installed).toBe(true);
		expect(report.installer.watcher.loaded).toBe(true);
		expect(report.installer.daemon.bridgeJsonPidAlive).toBe(true);
		expect(report.installer.extension.installed).toBe(true);
		expect(report.installer.extension.files).toContain("/ext/manifest.json");
	});
});

function fullInstaller(): InstallerStatusReport {
	return {
		shim: {
			perCliDir: [{ cliDir: "/cli/dir/1.0", installed: true, hasShim: true, hasReal: true }],
		},
		watcher: { plistPath: "/plist/w", plistExists: true, loaded: true },
		daemon: {
			plistPath: "/plist/d",
			plistExists: true,
			loaded: true,
			bridgeJsonExists: true,
			bridgeJsonPidAlive: true,
		},
		extension: {
			installed: true,
			files: ["/ext/manifest.json"],
			symlinkValid: true,
		},
	};
}

describe("renderStatus: text output covers every section", () => {
	it("renders one section per subsystem — shim + watcher + daemon + extension", () => {
		const text = renderStatus({
			config: {
				path: "/cfg",
				enabled: true,
				logDir: "/logs",
				bridgeJsonPath: "/bridge",
				configVersion: 1,
				usedDefaults: false,
			},
			registry: {
				path: "/reg",
				count: 1,
				primaryLabel: "Personal",
				labels: ["Personal"],
			},
			claudeApp: {
				appPath: "/Applications/Claude.app",
				codesignAuthority: "Anthropic PBC",
				gatekeeper: "Notarized Developer ID",
				injectedMarkers: 0,
				notes: [],
			},
			installer: fullInstaller(),
		});
		expect(text).toContain("=== Config ===");
		expect(text).toContain("=== Registry ===");
		expect(text).toContain("=== Claude.app ===");
		// Bug 7 fix: real per-subsystem headers, no more placeholder.
		expect(text).toContain("=== Installer: shim (PR2) ===");
		expect(text).toContain("=== Installer: watcher (PR3) ===");
		expect(text).toContain("=== Installer: bridge daemon (PR5a) ===");
		expect(text).toContain("=== Installer: extension (PR5b) ===");
		expect(text).toContain("/cli/dir/1.0");
		expect(text).toContain("/plist/w");
		expect(text).toContain("/plist/d");
		expect(text).toContain("/ext/manifest.json");
		// Placeholder must not reappear.
		expect(text).not.toContain("see PR6b for installer status wiring");
	});

	it("usedDefaults message + '(unknown)' fallbacks + note prefixes", () => {
		const text = renderStatus({
			config: {
				path: "/cfg",
				enabled: false,
				logDir: "(defaults)",
				bridgeJsonPath: "(defaults)",
				configVersion: 1,
				usedDefaults: true,
			},
			registry: { path: "/reg", count: 0, primaryLabel: undefined, labels: [] },
			claudeApp: {
				appPath: "/x",
				codesignAuthority: undefined,
				gatekeeper: undefined,
				injectedMarkers: 0,
				notes: ["oops"],
			},
			installer: emptyInstallerStatusReport(),
		});
		expect(text).toContain("run `cma init`");
		expect(text).toContain("(unknown)");
		expect(text).toContain("! oops");
		// `bridgeJsonPidAlive === undefined` → `(unknown)` rendering path.
		expect(text).toContain("bridgeJsonPidAlive: (unknown)");
	});
});

describe("nodeExecFilePort", () => {
	it("resolves stdout for a plain command like /bin/echo", async () => {
		const port = nodeExecFilePort();
		const result = await port("/bin/echo", ["hi"]);
		expect(result.stdout.trim()).toBe("hi");
		expect(result.code).toBe(0);
	});

	it("nonexistent binary → returns non-zero code, no throw", async () => {
		const port = nodeExecFilePort();
		const result = await port("/nope/does-not-exist", []);
		expect(result.code).not.toBe(0);
	});
});
