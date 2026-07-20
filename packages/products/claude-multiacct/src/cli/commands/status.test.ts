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
import { type ExecFileFn, collectStatus, nodeExecFilePort, renderStatus } from "./status.ts";
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
		});
		expect(report.config.usedDefaults).toBe(false);
		expect(report.config.enabled).toBe(true);
		expect(report.registry.count).toBe(1);
		expect(report.registry.primaryLabel).toBe("Personal");
		expect(report.registry.labels).toStrictEqual(["Personal"]);
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
		});
		expect(report.claudeApp.codesignAuthority).toBeUndefined();
		expect(report.claudeApp.gatekeeper).toContain("no such file");
		expect(report.claudeApp.notes.length).toBeGreaterThan(0);
	});
});

describe("renderStatus: text output covers every section", () => {
	it("prints Config, Registry, Claude.app, Installer headers + fields", () => {
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
			installer: { note: "PR6b" },
		});
		expect(text).toContain("=== Config ===");
		expect(text).toContain("=== Registry ===");
		expect(text).toContain("=== Claude.app ===");
		expect(text).toContain("=== Installer ===");
		expect(text).toContain("/cfg");
		expect(text).toContain("Personal");
		expect(text).toContain("Anthropic PBC");
		expect(text).toContain("PR6b");
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
			installer: { note: "later" },
		});
		expect(text).toContain("run `cma init`");
		expect(text).toContain("(unknown)");
		expect(text).toContain("! oops");
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
