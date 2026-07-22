/* oxlint-disable vitest/no-conditional-in-test, vitest/require-mock-type-parameters, eslint/require-await, unicorn/no-useless-undefined, typescript/explicit-function-return-type, typescript/consistent-indexed-object-style, typescript/consistent-type-imports, unicorn/prefer-at, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, eslint/curly, unicorn/no-await-expression-member, unicorn/no-unreadable-array-destructuring */
/**
 * Intent: the runtime bindings for the native reconcile. The load-bearing pins:
 * every `security` read runs under the 5-second cap (a dropped timeout hangs the
 * daemon at boot) and fails soft to undefined; the config.json v10 reader yields
 * only the encrypted `djEw` values and stays silent on a missing/malformed file
 * so boot survives; `provisionNative` maps provisionAccount's result and drives
 * the injected verify with the REAL account uuid (not a random one); and
 * `detectNative` fails closed when Claude.app's config marker cannot be read.
 */

import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CHROMIUM_IV, CHROMIUM_V10_PREFIX, deriveChromiumKey } from "./chromium-crypto.ts";

type ExecFileCallback = (
	err: (Error & { code?: number }) | null,
	stdout: string,
	stderr: string,
) => void;
type ExecFileArgs = [
	string,
	readonly string[],
	{ timeout?: number; maxBuffer?: number } | undefined,
	ExecFileCallback,
];

const execFileSpy = vi.fn();
const readFileSpy = vi.fn();

// provisionNative wraps the real provisionAccount + a real AtomicRegistryWriter
// pointed at ~/.config. Mock the provisioning module so the test drives the
// ok/failure mapping and the injected verify without touching the real registry.
let provisionImpl: (input: {
	token: string;
	label: string;
	identity?: unknown;
	source?: string;
	ports: { verify: (token: string) => Promise<unknown> };
}) => Promise<unknown> = () => Promise.resolve({ ok: false, kind: "unset", detail: "unset" });
vi.mock("../oauth/provisioning.ts", () => ({
	provisionAccount: (input: never) => provisionImpl(input as never),
	flagOn: () => false,
}));

vi.mock("node:child_process", async () => {
	const { promisify } = await import("node:util");
	function mockExecFile(...args: unknown[]): void {
		execFileSpy(...args);
		const cb = args[args.length - 1] as ExecFileCallback;
		queueMicrotask(() => execFileImpl(args, cb));
	}
	(mockExecFile as unknown as { [k: symbol]: unknown })[promisify.custom] = (
		file: string,
		argv: readonly string[],
		opts?: { timeout?: number },
	): Promise<{ stdout: string; stderr: string }> =>
		new Promise((resolve, reject) => {
			const args: unknown[] = opts === undefined ? [file, argv] : [file, argv, opts];
			mockExecFile(...args, (err: Error | null, stdout: string, stderr: string) => {
				if (err !== null) {
					reject(err);
					return;
				}
				resolve({ stdout, stderr });
			});
		});
	return { execFile: mockExecFile };
});

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return { ...actual, readFile: (path: string, encoding?: string) => readFileSpy(path, encoding) };
});

let execFileImpl: (args: unknown[], cb: ExecFileCallback) => void = (_args, cb) => {
	cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
};

async function importReal(): Promise<typeof import("./real-discovery-ports.ts")> {
	return import("./real-discovery-ports.ts");
}

const noopLogger = { log: () => {}, warn: () => {} };

function resetMocks(): void {
	execFileSpy.mockClear();
	readFileSpy.mockReset();
	readFileSpy.mockImplementation(() => Promise.reject(new Error("ENOENT")));
	provisionImpl = () => Promise.resolve({ ok: false, kind: "unset", detail: "unset" });
	execFileImpl = (_args, cb) => {
		cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
	};
}

async function makeDiscovery(over: Record<string, unknown> = {}) {
	const { makeRealDiscoveryPorts } = await importReal();
	return makeRealDiscoveryPorts({
		tokenStore: { put: async () => {} } as never,
		readRegistry: async () => undefined,
		logger: noopLogger,
		...over,
	} as never);
}

describe("makeActiveTokenPorts.readKeychainPassword", () => {
	it("caps the security call at 5s (drop the timeout → daemon boot can hang forever)", async () => {
		resetMocks();
		let capturedOpts: { timeout?: number } | undefined;
		execFileImpl = (args, cb) => {
			const [, , third] = args as ExecFileArgs;
			capturedOpts = third;
			cb(null, "TOKEN\n", "");
		};
		const { makeActiveTokenPorts } = await importReal();
		const ports = makeActiveTokenPorts(noopLogger);
		expect(await ports.readKeychainPassword("Claude Safe Storage", "Claude Key")).toBe("TOKEN");
		expect(capturedOpts?.timeout).toBe(5000);
	});

	it("returns undefined and warns when security fails (missing item, timeout, or ACL denial)", async () => {
		resetMocks();
		const warned: string[] = [];
		const { makeActiveTokenPorts } = await importReal();
		const ports = makeActiveTokenPorts({ warn: (m) => warned.push(m) });
		expect(await ports.readKeychainPassword("missing", "acct")).toBeUndefined();
		expect(warned.some((m) => m.includes("readKeychainPassword"))).toBe(true);
	});

	it("configJsonPath points at Claude's config.json", async () => {
		const { makeActiveTokenPorts } = await importReal();
		expect(makeActiveTokenPorts(noopLogger).configJsonPath).toMatch(/Claude\/config\.json$/u);
	});
});

describe("makeActiveTokenPorts.iterateAppConfigJson (config.json v10 reader)", () => {
	it("yields decoded v10 bytes for each base64-`djEw` string, filtering the rest", async () => {
		resetMocks();
		const blobA = Buffer.concat([Buffer.from("v10"), Buffer.from("cipher-A")]);
		const blobB = Buffer.concat([Buffer.from("v10"), Buffer.from("cipher-B")]);
		readFileSpy.mockImplementation(() =>
			Promise.resolve(
				JSON.stringify({
					locale: "en-US",
					counter: 42,
					blob: null,
					"oauth:tokenCache": blobA.toString("base64"),
					"oauth:tokenCacheV2": blobB.toString("base64"),
					unrelated: "not-encrypted",
				}),
			),
		);
		const { makeActiveTokenPorts } = await importReal();
		const ports = makeActiveTokenPorts(noopLogger);
		const yields: Array<{ key: string; startsV10: boolean }> = [];
		for await (const e of ports.iterateAppConfigJson("/tmp/config.json")) {
			yields.push({
				key: e.key.toString("utf8"),
				startsV10: e.value.subarray(0, 3).toString() === "v10",
			});
		}
		expect(yields.map((y) => y.key).toSorted()).toEqual(["oauth:tokenCache", "oauth:tokenCacheV2"]);
		expect(yields.every((y) => y.startsV10)).toBe(true);
	});

	it("yields nothing when the file is missing (silent — daemon must still boot)", async () => {
		resetMocks();
		const ports = (await importReal()).makeActiveTokenPorts(noopLogger);
		const out = [];
		for await (const e of ports.iterateAppConfigJson("/nope/config.json")) out.push(e);
		expect(out).toEqual([]);
	});

	it("warns and yields nothing when config.json is malformed JSON", async () => {
		resetMocks();
		readFileSpy.mockImplementation(() => Promise.resolve("not-json{{"));
		const warned: string[] = [];
		const ports = (await importReal()).makeActiveTokenPorts({ warn: (m) => warned.push(m) });
		const out = [];
		for await (const e of ports.iterateAppConfigJson("/tmp/config.json")) out.push(e);
		expect(out).toEqual([]);
		expect(warned.some((m) => m.includes("is not valid JSON"))).toBe(true);
	});

	it("yields nothing when the top-level JSON is not an object", async () => {
		resetMocks();
		readFileSpy.mockImplementation(() => Promise.resolve("[1,2,3]"));
		const ports = (await importReal()).makeActiveTokenPorts(noopLogger);
		const out = [];
		for await (const e of ports.iterateAppConfigJson("/tmp/config.json")) out.push(e);
		expect(out).toEqual([]);
	});
});

describe("makeRealDiscoveryPorts.provisionNative", () => {
	it("maps a successful provisionAccount to {ok, uuid} and drives verify with the REAL account uuid", async () => {
		resetMocks();
		let seen: { accountUuid?: string; source?: string } = {};
		provisionImpl = async (input) => {
			const verified = (await input.ports.verify(input.token)) as { accountUuid: string };
			seen = { accountUuid: verified.accountUuid, source: input.source };
			return { ok: true, account: { uuid: verified.accountUuid } };
		};
		const ports = await makeDiscovery();
		const result = await ports.provisionNative({
			token: "T-1",
			label: "icloud",
			accountUuid: "918f32f7-44c2-442e-8d5d-48ca3792ea95" as never,
			identity: { email: "cole@icloud.com" },
			subscriptionType: "claude_max",
			rateLimitTier: "unknown",
		});
		expect(result).toEqual({ ok: true, uuid: "918f32f7-44c2-442e-8d5d-48ca3792ea95" });
		// The verify the native path injects returns the real account uuid, NOT a
		// freshly-minted random one, and the account is tagged source=native.
		expect(seen.accountUuid).toBe("918f32f7-44c2-442e-8d5d-48ca3792ea95");
		expect(seen.source).toBe("native");
	});

	it("maps a failed provisionAccount to {ok:false, kind, detail} with an empty-string detail fallback", async () => {
		resetMocks();
		provisionImpl = () => Promise.resolve({ ok: false, kind: "duplicate_uuid" }); // detail omitted
		const ports = await makeDiscovery();
		const result = await ports.provisionNative({
			token: "T-2",
			label: "work",
			accountUuid: "22222222-2222-4222-8222-222222222222" as never,
			identity: {},
			subscriptionType: "unknown",
			rateLimitTier: "unknown",
		});
		expect(result).toEqual({ ok: false, kind: "duplicate_uuid", detail: "" });
	});
});

describe("makeRealDiscoveryPorts.detectNative", () => {
	it("fails closed to undefined when Claude.app's config.json cannot be read", async () => {
		resetMocks(); // readFile rejects → no lastKnownAccountUuid → no keychain/network touched
		const ports = await makeDiscovery();
		expect(await ports.detectNative()).toBeUndefined();
		// No keychain read is attempted once the marker is absent.
		expect(execFileSpy).not.toHaveBeenCalled();
	});

	it("readRegistry is passed through unchanged", async () => {
		resetMocks();
		const reg = { accounts: [] };
		const ports = await makeDiscovery({ readRegistry: async () => reg });
		expect(await ports.readRegistry()).toBe(reg);
	});

	it("resolves the native account end-to-end (marker → keychain decrypt → profile match)", async () => {
		// Wire the real bindings: config.json (plaintext marker + a V2 v10 blob),
		// the keychain password (execFile), and the profile API (global fetch). This
		// exercises the keychain read, the config decrypt, and the profile fetch the
		// detectNative closures compose.
		resetMocks();
		const NATIVE = "918f32f7-44c2-442e-8d5d-48ca3792ea95";
		const password = "safe-storage-pw";
		const key = deriveChromiumKey(password);
		const cache = JSON.stringify({
			"seg0:ws:https://api.anthropic.com:profile inference": { token: "tok-native" },
		});
		const cipher = createCipheriv("aes-128-cbc", key, CHROMIUM_IV);
		cipher.setAutoPadding(true);
		const blob = Buffer.concat([
			CHROMIUM_V10_PREFIX,
			cipher.update(Buffer.from(cache, "utf8")),
			cipher.final(),
		]);
		readFileSpy.mockImplementation(() =>
			Promise.resolve(
				JSON.stringify({
					lastKnownAccountUuid: NATIVE,
					"oauth:tokenCacheV2": blob.toString("base64"),
				}),
			),
		);
		execFileImpl = (_args, cb) => cb(null, `${password}\n`, "");
		const fetchStub = vi.fn(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				text: () =>
					Promise.resolve(
						JSON.stringify({
							account: { uuid: NATIVE, email: "cole@icloud.com", display_name: "Cole" },
						}),
					),
			}),
		);
		vi.stubGlobal("fetch", fetchStub);
		try {
			const ports = await makeDiscovery();
			const detected = await ports.detectNative();
			expect(detected?.accountUuid).toBe(NATIVE);
			expect(detected?.token).toBe("tok-native");
			expect(detected?.identity).toEqual({ email: "cole@icloud.com", displayName: "Cole" });
			expect(fetchStub).toHaveBeenCalledWith(
				"https://api.anthropic.com/api/oauth/profile",
				expect.objectContaining({ method: "GET" }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
