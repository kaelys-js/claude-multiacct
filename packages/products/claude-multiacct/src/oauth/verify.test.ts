/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, eslint/prefer-promise-reject-errors, unicorn/numeric-separators-style, typescript/explicit-function-return-type */
/**
 * Intent: `verifyToken` is the CLI-shelling gatekeeper for provisioning.
 * Two properties are load-bearing and adversarial:
 *
 *   1. Errors are CLASSIFIED, not collapsed. If the code merged
 *      `unauthorized` and `network` into a single "failed", the wrong
 *      operator hint would ship. The kind-distinguishing tests below
 *      immediately go red under that collapse.
 *   2. The subprocess env only ADDS `CLAUDE_CODE_OAUTH_TOKEN` — every
 *      inherited PATH/HOME/TMPDIR is preserved. Dropping the inherited
 *      env would break the CLI's runtime resource resolution.
 *
 * `exec` is injected as a `VerifyExec` spy pinning argv (path + probe
 * subcommand + no shell) and env (single added key), so the tests don't
 * shell out.
 */

import { describe, expect, it, vi } from "vitest";
import { assertNotOk, assertOk } from "./test-utils.ts";
import { type VerifyExec, verifyToken } from "./verify.ts";

// Injected exec that rejects with a raw string to exercise `errMsg`'s
// non-Error fallback branch. Hoisted so unicorn/consistent-function-scoping
// stays happy.
// oxlint-disable-next-line prefer-promise-reject-errors
const execRejectsRawString: VerifyExec = () =>
	Promise.reject("weird raw string" as unknown as Error);

const UUID = "11111111-1111-4111-8111-111111111111";

function makeExec(response: Awaited<ReturnType<VerifyExec>> | Error): {
	exec: VerifyExec;
	calls: Array<{
		file: string;
		args: readonly string[];
		env: Record<string, string | undefined>;
		timeoutMs: number;
	}>;
} {
	const calls: Array<{
		file: string;
		args: readonly string[];
		env: Record<string, string | undefined>;
		timeoutMs: number;
	}> = [];
	const exec: VerifyExec = (file, args, options): Promise<Awaited<ReturnType<VerifyExec>>> => {
		calls.push({ file, args, env: options.env, timeoutMs: options.timeoutMs });
		return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
	};
	return { exec, calls };
}

describe("verifyToken — happy path", () => {
	it("returns ok:true with the parsed identity fields", async () => {
		const stdout = JSON.stringify({
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			accountUuid: UUID,
		});
		const { exec } = makeExec({ stdout, stderr: "", exitCode: 0 });
		const result = await verifyToken({
			token: "sk-ant-oat01-x",
			claudeRealPath: "/tmp/claude.real",
			exec,
		});
		expect(result).toEqual({
			ok: true,
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			accountUuid: UUID,
		});
	});

	it("attaches orgUuid when present", async () => {
		const stdout = JSON.stringify({
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			accountUuid: UUID,
			orgUuid: "22222222-2222-4222-8222-222222222222",
		});
		const { exec } = makeExec({ stdout, stderr: "", exitCode: 0 });
		const result = await verifyToken({
			token: "t",
			claudeRealPath: "/tmp/claude.real",
			exec,
		});
		assertOk(result);
		expect(result.orgUuid).toBe("22222222-2222-4222-8222-222222222222");
	});

	it("pins argv (path + default probe subcommand 'usage', no shell) and env (single added key)", async () => {
		const stdout = JSON.stringify({
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			accountUuid: UUID,
		});
		const { exec, calls } = makeExec({ stdout, stderr: "", exitCode: 0 });
		await verifyToken({
			token: "SECRET",
			claudeRealPath: "/opt/claude.real",
			exec,
			timeoutMs: 5000,
		});
		expect(calls).toHaveLength(1);
		const [call] = calls;
		if (call === undefined) {
			throw new Error("no call recorded");
		}
		expect(call.file).toBe("/opt/claude.real");
		expect(call.args).toEqual(["usage"]);
		expect(call.timeoutMs).toBe(5000);
		expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("SECRET");
		// Load-bearing: the process.env inheritance must be preserved. PATH is
		// nearly-always present under vitest — if the impl dropped inherited
		// env this would go undefined.
		expect(call.env.PATH).toBeDefined();
	});

	it("honours probeArgs override + custom timeoutMs", async () => {
		const { exec, calls } = makeExec({
			stdout: JSON.stringify({
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				accountUuid: UUID,
			}),
			stderr: "",
			exitCode: 0,
		});
		await verifyToken({
			token: "t",
			claudeRealPath: "/x",
			exec,
			probeArgs: ["identity", "--json"],
			timeoutMs: 1234,
		});
		expect(calls[0]?.args).toEqual(["identity", "--json"]);
		expect(calls[0]?.timeoutMs).toBe(1234);
	});
});

describe("verifyToken — classified failures (adversarial: collapsing them goes red)", () => {
	it("401 exit → unauthorized (distinct from network)", async () => {
		const { exec } = makeExec({ stdout: "", stderr: "", exitCode: 401 });
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("unauthorized");
	});

	it("stderr containing 'Unauthorized' → unauthorized", async () => {
		const { exec } = makeExec({
			stdout: "",
			stderr: "Error: Unauthorized (401)",
			exitCode: 1,
		});
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("unauthorized");
	});

	it("thrown ENETUNREACH → network (distinct from unauthorized)", async () => {
		const err: NodeJS.ErrnoException = Object.assign(new Error("netdown"), {
			code: "ENETUNREACH",
		});
		const { exec } = makeExec(err);
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("network");
	});

	it("thrown ETIMEDOUT → network", async () => {
		const err: NodeJS.ErrnoException = Object.assign(new Error("timeout"), {
			code: "ETIMEDOUT",
		});
		const { exec } = makeExec(err);
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("network");
	});

	it("outcome.error with network errno → network", async () => {
		const { exec } = makeExec({
			stdout: "",
			stderr: "",
			exitCode: 0,
			error: Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
		});
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("network");
	});

	it("outcome.error with non-network errno → unexpected", async () => {
		const { exec } = makeExec({
			stdout: "",
			stderr: "",
			exitCode: 0,
			error: Object.assign(new Error("boom"), { code: "EWEIRD" }),
		});
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("unexpected");
	});

	it("non-zero exit that is not auth-shaped → unexpected", async () => {
		const { exec } = makeExec({ stdout: "", stderr: "boom", exitCode: 3 });
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("unexpected");
	});

	it("non-JSON stdout on exit 0 → malformed", async () => {
		const { exec } = makeExec({ stdout: "not json at all", stderr: "", exitCode: 0 });
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("malformed");
	});

	it("JSON stdout with wrong shape (missing fields) → malformed", async () => {
		const { exec } = makeExec({
			stdout: JSON.stringify({ what: "ever" }),
			stderr: "",
			exitCode: 0,
		});
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("malformed");
	});

	it("thrown generic (no errno code) → unexpected", async () => {
		const { exec } = makeExec(new Error("no code on this"));
		const result = await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		assertNotOk(result);
		expect(result.kind).toBe("unexpected");
	});

	it("non-Error throwable (string) → detail stringifies via fallback branch", async () => {
		const result = await verifyToken({
			token: "t",
			claudeRealPath: "/x",
			exec: execRejectsRawString,
		});
		assertNotOk(result);
		expect(result.detail).toBe("weird raw string");
	});
});

describe("verifyToken — default timeout", () => {
	it("defaults timeoutMs to 10000 when not passed (pins the default-arg)", async () => {
		const { exec, calls } = makeExec({
			stdout: JSON.stringify({
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				accountUuid: UUID,
			}),
			stderr: "",
			exitCode: 0,
		});
		await verifyToken({ token: "t", claudeRealPath: "/x", exec });
		expect(calls[0]?.timeoutMs).toBe(10000);
	});
});

describe("verifyToken spy sanity", () => {
	it("makeExec spy tracks calls (guards against silent no-call regressions)", async () => {
		const { exec, calls } = makeExec({
			stdout: JSON.stringify({
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				accountUuid: UUID,
			}),
			stderr: "",
			exitCode: 0,
		});
		const spy = vi.fn<VerifyExec>(exec);
		await verifyToken({ token: "t", claudeRealPath: "/x", exec: spy });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(1);
	});
});
