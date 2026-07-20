/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `cma doctor` classifies status fields. Read-only.
 *
 *   - Every field is classified into ok / warn / error with an actionable
 *     `fix` on non-ok findings. Adversarial: strip the `fix` field on a
 *     failure case → the "each non-ok has a fix hint" test goes red.
 *   - Rule 12: a real problem (e.g. registry has no primary) produces an
 *     ERROR-tier finding, not a WARN.
 */

import { describe, expect, it, vi } from "vitest";
/* oxlint-disable vitest/expect-expect */
import type { ExecFileFn } from "./status.ts";
import { collectDoctor, renderDoctor } from "./doctor.ts";
import { defaultConfig } from "../config-store.ts";

function makeExec(
	responses: Record<string, { stdout?: string; stderr?: string; code?: number }>,
): ExecFileFn {
	return vi.fn(async (file: string) => {
		const r = responses[file] ?? { code: 1 };
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
	});
}

const HAPPY_EXEC = makeExec({
	codesign: { stderr: "Authority=Developer ID Application: Anthropic PBC\n", code: 0 },
	spctl: { stderr: "source=Notarized Developer ID\n", code: 0 },
});

describe("collectDoctor", () => {
	it("all-happy inputs → every finding is 'ok'", async () => {
		const { findings } = await collectDoctor({
			configPath: "/cfg",
			config: defaultConfig(),
			registryPath: "/reg",
			registry: {
				accounts: [
					{
						uuid: "11111111-1111-4111-8111-111111111111" as never,
						label: "P",
						isPrimary: true,
						subscriptionType: "Pro",
						rateLimitTier: "tier-2",
						encryptedTokenRef: "keychain:a",
					},
				],
			},
			appPath: "/Applications/Claude.app",
			execFile: HAPPY_EXEC,
		});
		expect(findings.every((f) => f.tier === "ok")).toBe(true);
	});

	it("missing config → config finding is WARN with a `cma init` fix", async () => {
		const { findings } = await collectDoctor({
			configPath: "/cfg",
			config: undefined,
			registryPath: "/reg",
			registry: undefined,
			appPath: "/Applications/Claude.app",
			execFile: HAPPY_EXEC,
		});
		const cfg = findings.find((f) => f.label === "config.json");
		expect(cfg?.tier).toBe("warn");
		expect(cfg?.fix).toContain("cma init");
	});

	it("empty registry → WARN with add-account fix", async () => {
		const { findings } = await collectDoctor({
			configPath: "/cfg",
			config: defaultConfig(),
			registryPath: "/reg",
			registry: undefined,
			appPath: "/Applications/Claude.app",
			execFile: HAPPY_EXEC,
		});
		const reg = findings.find((f) => f.label === "registry");
		expect(reg?.tier).toBe("warn");
		expect(reg?.fix).toContain("cma account add");
	});

	it("registry with no primary → ERROR (Rule 12: real invariant violation)", async () => {
		const { findings } = await collectDoctor({
			configPath: "/cfg",
			config: defaultConfig(),
			registryPath: "/reg",
			registry: {
				accounts: [
					{
						uuid: "11111111-1111-4111-8111-111111111111" as never,
						label: "P",
						isPrimary: false,
						subscriptionType: "Pro",
						rateLimitTier: "tier-2",
						encryptedTokenRef: "keychain:a",
					},
				],
			},
			appPath: "/Applications/Claude.app",
			execFile: HAPPY_EXEC,
		});
		const reg = findings.find((f) => f.label === "registry");
		expect(reg?.tier).toBe("error");
		expect(reg?.fix).toContain("set-primary");
	});

	it("missing Claude.app codesign → ERROR with reinstall fix", async () => {
		const { findings } = await collectDoctor({
			configPath: "/cfg",
			config: defaultConfig(),
			registryPath: "/reg",
			registry: undefined,
			appPath: "/nope",
			execFile: makeExec({
				codesign: { stderr: "not found", code: 1 },
				spctl: { stderr: "not found", code: 1 },
			}),
		});
		const cs = findings.find((f) => f.label === "Claude.app codesign");
		expect(cs?.tier).toBe("error");
		expect(cs?.fix).toContain("claude.ai/download");
	});

	it("gatekeeper missing but codesign present → gatekeeper WARN only", async () => {
		const { findings } = await collectDoctor({
			configPath: "/cfg",
			config: defaultConfig(),
			registryPath: "/reg",
			registry: undefined,
			appPath: "/Applications/Claude.app",
			execFile: makeExec({
				codesign: { stderr: "Authority=X\n", code: 0 },
				// spctl unreadable — stderr empty, code non-zero → extractGatekeeper
				// returns undefined via the "" fallback path.
				spctl: { stdout: "", stderr: "", code: 3 },
			}),
		});
		const gk = findings.find((f) => f.label === "Claude.app gatekeeper");
		expect(gk?.tier).toBe("warn");
	});
});

describe("renderDoctor", () => {
	it("formats each finding with tier tag; includes fix on non-ok", () => {
		const text = renderDoctor([
			{ label: "one", tier: "ok", message: "good" },
			{ label: "two", tier: "warn", message: "meh", fix: "do X" },
			{ label: "three", tier: "error", message: "bad", fix: "do Y" },
		]);
		expect(text).toContain("ok");
		expect(text).toContain("WARN");
		expect(text).toContain("ERROR");
		expect(text).toContain("fix: do X");
		expect(text).toContain("fix: do Y");
	});
});
