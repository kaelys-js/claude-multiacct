/* oxlint-disable vitest/no-conditional-in-test, vitest/require-mock-type-parameters, eslint/require-await, unicorn/no-useless-undefined, typescript/explicit-function-return-type, typescript/consistent-indexed-object-style, typescript/consistent-type-imports, unicorn/prefer-at, unicorn/no-unreadable-array-destructuring, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */
/**
 * Intent: `listClaudeCliServices` used to enumerate every keychain item via
 * `security dump-keychain` and grep the output. Under launchd that call
 * blocks on per-item ACL prompts and hangs the daemon at boot; the fix is
 * to probe a bounded candidate set with `find-generic-password -s <label>`
 * instead. These tests pin the three sources that build that candidate
 * set (registry, canonical unsuffixed service, user-declared arrays) and
 * the 5-second timeout every `security` call now runs under.
 *
 * Adversarial: drop `SECURITY_CALL_TIMEOUT_MS` from the execFile options
 * and the "hard 5s cap" assertion flips red. Drop the registry branch and
 * the "probes labels from registry" assertion flips red.
 */

import { describe, expect, it, vi } from "vitest";

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
const readdirSpy = vi.fn();
const statSpy = vi.fn();

// provisionOne wraps the real provisionAccount + a real AtomicRegistryWriter
// pointed at ~/.config. Mock the provisioning module so the test drives
// provisionOne's ok/failure mapping (and the syntheticVerify it injects)
// without ever touching the real registry on disk.
let provisionImpl: (input: {
	token: string;
	label: string;
	ports: { verify: (token: string) => Promise<unknown> };
}) => Promise<unknown> = () => Promise.resolve({ ok: false, kind: "unset", detail: "unset" });
vi.mock("../oauth/provisioning.ts", () => ({
	provisionAccount: (input: never) => provisionImpl(input as never),
	flagOn: () => false,
}));

vi.mock("node:child_process", async () => {
	const { promisify } = await import("node:util");
	// The real `execFile` carries a `util.promisify.custom` symbol so
	// `promisify(execFile)` resolves to `{stdout, stderr}` rather than the
	// first callback arg. When we mock the module, that symbol is gone —
	// so we attach our own promisified form that returns the same shape.
	function mockExecFile(...args: unknown[]): void {
		execFileSpy(...args);
		const cb = args[args.length - 1] as ExecFileCallback;
		const [, , third] = args as ExecFileArgs;
		const opts =
			typeof third === "object" && third !== null && !Array.isArray(third) ? third : undefined;
		const impl = execFileImpl;
		queueMicrotask(() => impl(args, opts, cb));
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
	return {
		...actual,
		readFile: (path: string, encoding?: string) => readFileSpy(path, encoding),
		readdir: (path: string) => readdirSpy(path),
		stat: (path: string) => statSpy(path),
	};
});

let execFileImpl: (
	args: unknown[],
	opts: { timeout?: number } | undefined,
	cb: ExecFileCallback,
) => void = (_args, _opts, cb) => {
	cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
};

async function importReal(): Promise<typeof import("./real-discovery-ports.ts")> {
	return import("./real-discovery-ports.ts");
}

function resetMocks(): void {
	execFileSpy.mockClear();
	readFileSpy.mockReset();
	readFileSpy.mockImplementation(() => Promise.reject(new Error("ENOENT")));
	readdirSpy.mockReset();
	readdirSpy.mockImplementation(() => Promise.reject(new Error("ENOENT")));
	statSpy.mockReset();
	statSpy.mockImplementation(() => Promise.reject(new Error("ENOENT")));
	provisionImpl = () => Promise.resolve({ ok: false, kind: "unset", detail: "unset" });
	execFileImpl = (_args, _opts, cb) => {
		cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
	};
}

const noopLogger = { log: () => {}, warn: () => {} };
function makePorts(
	over: Partial<
		Parameters<typeof import("./real-discovery-ports.ts").makeRealDiscoveryPorts>[0]
	> = {},
): Promise<ReturnType<typeof import("./real-discovery-ports.ts").makeRealDiscoveryPorts>> {
	return importReal().then(({ makeRealDiscoveryPorts }) =>
		makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: noopLogger,
			...over,
		}),
	);
}

describe("makeRealDiscoveryPorts.readKeychainPassword", () => {
	it("caps the security call at 5s (drop the timeout → daemon boot can hang forever)", async () => {
		resetMocks();
		let capturedOpts: { timeout?: number } | undefined;
		execFileImpl = (_args, opts, cb) => {
			capturedOpts = opts;
			cb(null, "TOKEN\n", "");
		};
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		const value = await ports.readKeychainPassword("Claude Safe Storage", "Claude");
		expect(value).toBe("TOKEN");
		expect(capturedOpts?.timeout).toBe(5000);
	});

	it("returns undefined when security fails (missing item, timeout, or ACL denial)", async () => {
		resetMocks();
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		expect(await ports.readKeychainPassword("missing", "acct")).toBeUndefined();
	});
});

describe("makeRealDiscoveryPorts.listClaudeCliServices", () => {
	it("probes the unsuffixed canonical service even when no other sources contribute", async () => {
		resetMocks();
		const probed: string[] = [];
		execFileImpl = (args, _opts, cb) => {
			const argv = args[1] as readonly string[];
			const sIdx = argv.indexOf("-s");
			if (sIdx >= 0) {
				probed.push(argv[sIdx + 1] as string);
			}
			cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
		};
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		const services = await ports.listClaudeCliServices();
		expect(services).toEqual([]);
		expect(probed).toContain("Claude Code-credentials");
	});

	it("probes labels from registry.json (expanded to Claude Code-credentials-<label>)", async () => {
		resetMocks();
		const probed = new Set<string>();
		execFileImpl = (args, _opts, cb) => {
			const argv = args[1] as readonly string[];
			const sIdx = argv.indexOf("-s");
			if (sIdx >= 0) {
				const svc = argv[sIdx + 1] as string;
				probed.add(svc);
				// Simulate "found" only for the registry-derived label so we
				// can assert the return list includes it.
				if (svc === "Claude Code-credentials-alice") {
					cb(null, "somepassword", "");
					return;
				}
			}
			cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
		};
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () =>
				({
					accounts: [
						{
							uuid: "11111111-1111-4111-8111-111111111111",
							label: "alice",
							isPrimary: true,
							subscriptionType: "u",
							rateLimitTier: "u",
							encryptedTokenRef: "r",
						},
					],
				}) as never,
			logger: { log: () => {}, warn: () => {} },
		});
		const services = await ports.listClaudeCliServices();
		expect(probed.has("Claude Code-credentials-alice")).toBe(true);
		expect(services).toContain("Claude Code-credentials-alice");
	});

	it("picks up an `accounts` array of strings from ~/.claude/.credentials.json", async () => {
		resetMocks();
		readFileSpy.mockImplementation((path: string) => {
			if (path.endsWith(".credentials.json")) {
				return Promise.resolve(JSON.stringify({ accounts: ["gmail"] }));
			}
			return Promise.reject(new Error("ENOENT"));
		});
		const probed = new Set<string>();
		execFileImpl = (args, _opts, cb) => {
			const argv = args[1] as readonly string[];
			const sIdx = argv.indexOf("-s");
			if (sIdx >= 0) {
				probed.add(argv[sIdx + 1] as string);
			}
			cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
		};
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		await ports.listClaudeCliServices();
		expect(probed.has("Claude Code-credentials-gmail")).toBe(true);
	});

	it("does NOT probe arbitrary top-level object keys (settings.json shape must not become a false candidate)", async () => {
		resetMocks();
		readFileSpy.mockImplementation((path: string) => {
			if (path.endsWith("settings.json")) {
				return Promise.resolve(
					JSON.stringify({ permissions: { allow: ["Bash(*)"] }, agentPushNotifEnabled: true }),
				);
			}
			return Promise.reject(new Error("ENOENT"));
		});
		const probed = new Set<string>();
		execFileImpl = (args, _opts, cb) => {
			const argv = args[1] as readonly string[];
			const sIdx = argv.indexOf("-s");
			if (sIdx >= 0) {
				probed.add(argv[sIdx + 1] as string);
			}
			cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
		};
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		await ports.listClaudeCliServices();
		// Object keys must not be probed — only the canonical fallback is present.
		expect(probed.has("Claude Code-credentials-permissions")).toBe(false);
		expect(probed.has("Claude Code-credentials-agentPushNotifEnabled")).toBe(false);
	});

	it("warns and continues when a candidate file exists but isn't valid JSON", async () => {
		resetMocks();
		readFileSpy.mockImplementation((path: string) => {
			if (path.endsWith(".credentials.json")) {
				return Promise.resolve("not-json{{");
			}
			return Promise.reject(new Error("ENOENT"));
		});
		const warned: string[] = [];
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: {
				log: () => {},
				warn: (m: string) => {
					warned.push(m);
				},
			},
		});
		const services = await ports.listClaudeCliServices();
		expect(services).toEqual([]);
		expect(warned.some((m) => m.includes("not valid JSON"))).toBe(true);
	});
});

describe("makeRealDiscoveryPorts.iterateAppConfigJson", () => {
	it("yields decoded v10 bytes for each base64-`djEw` string value in config.json", async () => {
		resetMocks();
		// Raw v10 blob → base64 begins `djEw`. Give two encrypted values +
		// one non-v10 string that must be filtered out.
		const blobA = Buffer.concat([Buffer.from("v10"), Buffer.from("cipher-A")]);
		const blobB = Buffer.concat([Buffer.from("v10"), Buffer.from("cipher-B")]);
		const config = {
			locale: "en-US",
			"oauth:tokenCache": blobA.toString("base64"),
			"oauth:tokenCacheV2": blobB.toString("base64"),
			unrelated: "not-encrypted",
		};
		readFileSpy.mockImplementation((path: string) =>
			path.endsWith("/config.json")
				? Promise.resolve(JSON.stringify(config))
				: Promise.reject(new Error("ENOENT")),
		);
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		const yields: Array<{ key: string; value: string }> = [];
		for await (const entry of ports.iterateAppConfigJson("/tmp/x/config.json")) {
			yields.push({ key: entry.key.toString("utf8"), value: entry.value.toString("binary") });
		}
		expect(yields).toHaveLength(2);
		expect(yields.map((y) => y.key).toSorted()).toEqual(["oauth:tokenCache", "oauth:tokenCacheV2"]);
		expect(yields[0]!.value.startsWith("v10")).toBe(true);
	});

	it("yields nothing when the file is missing (silent — daemon must still boot)", async () => {
		resetMocks();
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		const yields = [];
		for await (const entry of ports.iterateAppConfigJson("/nope/config.json")) {
			yields.push(entry);
		}
		expect(yields).toEqual([]);
	});

	it("warns and yields nothing when config.json is malformed JSON", async () => {
		resetMocks();
		readFileSpy.mockImplementation(() => Promise.resolve("not-json{{"));
		const warned: string[] = [];
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: {
				log: () => {},
				warn: (m: string) => {
					warned.push(m);
				},
			},
		});
		const yields = [];
		for await (const entry of ports.iterateAppConfigJson("/tmp/config.json")) {
			yields.push(entry);
		}
		expect(yields).toEqual([]);
		expect(warned.some((m) => m.includes("is not valid JSON"))).toBe(true);
	});

	it("filters out non-string and non-`djEw` values (locale / plain strings must not be yielded)", async () => {
		resetMocks();
		readFileSpy.mockImplementation(() =>
			Promise.resolve(
				JSON.stringify({
					locale: "en-US",
					counter: 42,
					flag: true,
					blob: null,
					"oauth:tokenCache": Buffer.concat([Buffer.from("v10"), Buffer.from("cipher")]).toString(
						"base64",
					),
				}),
			),
		);
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		const yields = [];
		for await (const entry of ports.iterateAppConfigJson("/tmp/config.json")) {
			yields.push(entry.key.toString("utf8"));
		}
		expect(yields).toEqual(["oauth:tokenCache"]);
	});

	it("yields nothing when the top-level JSON is not an object (e.g. array or scalar)", async () => {
		resetMocks();
		readFileSpy.mockImplementation(() => Promise.resolve("[1,2,3]"));
		const { makeRealDiscoveryPorts } = await importReal();
		const ports = makeRealDiscoveryPorts({
			tokenStore: { put: async () => {} } as never,
			readRegistry: async () => undefined,
			logger: { log: () => {}, warn: () => {} },
		});
		const yields = [];
		for await (const entry of ports.iterateAppConfigJson("/tmp/config.json")) {
			yields.push(entry);
		}
		expect(yields).toEqual([]);
	});
});

describe("makeRealDiscoveryPorts.readClaudeCliCredential", () => {
	it("strips the trailing newline security appends", async () => {
		resetMocks();
		execFileImpl = (_args, _opts, cb) => {
			cb(null, "raw-token\n", "");
		};
		const ports = await makePorts();
		const raw = await ports.readClaudeCliCredential("Claude Code-credentials-x");
		expect(raw).toBe("raw-token");
	});

	it("returns undefined when security fails (missing slot)", async () => {
		resetMocks(); // default execFileImpl errors with code 44
		const ports = await makePorts();
		expect(await ports.readClaudeCliCredential("Claude Code-credentials-missing")).toBeUndefined();
	});
});

describe("makeRealDiscoveryPorts.listClaudeCliServices — label sources", () => {
	it("keeps a registry label already in canonical form as-is (no double prefix)", async () => {
		resetMocks();
		const probed = new Set<string>();
		execFileImpl = (args, _opts, cb) => {
			const argv = args[1] as readonly string[];
			const sIdx = argv.indexOf("-s");
			if (sIdx >= 0) {
				probed.add(argv[sIdx + 1] as string);
			}
			cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
		};
		const ports = await makePorts({
			readRegistry: async () =>
				({
					accounts: [
						{
							uuid: "11111111-1111-4111-8111-111111111111",
							label: "Claude Code-credentials-bob",
							isPrimary: true,
							subscriptionType: "u",
							rateLimitTier: "u",
							encryptedTokenRef: "r",
						},
					],
				}) as never,
		});
		await ports.listClaudeCliServices();
		// The label was already fully-qualified → probed verbatim, not re-prefixed.
		expect(probed.has("Claude Code-credentials-bob")).toBe(true);
		expect(probed.has("Claude Code-credentials-Claude Code-credentials-bob")).toBe(false);
	});

	it("accepts a top-level string array and a `credentials` array from the label files", async () => {
		resetMocks();
		readFileSpy.mockImplementation((path: string) => {
			if (path.endsWith(".credentials.json")) {
				return Promise.resolve(JSON.stringify(["work"]));
			}
			if (path.endsWith("settings.json")) {
				return Promise.resolve(JSON.stringify({ credentials: ["home"] }));
			}
			return Promise.reject(new Error("ENOENT"));
		});
		const probed = new Set<string>();
		execFileImpl = (args, _opts, cb) => {
			const argv = args[1] as readonly string[];
			const sIdx = argv.indexOf("-s");
			if (sIdx >= 0) {
				probed.add(argv[sIdx + 1] as string);
			}
			cb(Object.assign(new Error("not found"), { code: 44 }), "", "");
		};
		const ports = await makePorts();
		await ports.listClaudeCliServices();
		expect(probed.has("Claude Code-credentials-work")).toBe(true);
		expect(probed.has("Claude Code-credentials-home")).toBe(true);
	});

	it("warns and continues when the registry read itself throws", async () => {
		resetMocks();
		const warned: string[] = [];
		const ports = await makePorts({
			readRegistry: () => Promise.reject(new Error("registry corrupt")),
			logger: { log: () => {}, warn: (m: string) => warned.push(m) },
		});
		const services = await ports.listClaudeCliServices();
		// Registry read failure is non-fatal — the canonical candidate is still probed.
		expect(services).toEqual([]);
		expect(warned.some((m) => m.includes("registry read failed"))).toBe(true);
	});
});

describe("makeRealDiscoveryPorts.listCloneApps", () => {
	it("maps `Claude Account <Label>.app` bundles to label + Application Support store dir", async () => {
		resetMocks();
		readdirSpy.mockImplementation(() =>
			Promise.resolve([
				"Claude Account Gmail.app",
				"Claude Account Work Space.app",
				"Safari.app",
				"not-a-clone",
			]),
		);
		const ports = await makePorts();
		const clones = await ports.listCloneApps();
		const labels = clones.map((c) => c.label);
		expect(labels).toEqual(["gmail", "work-space"]);
		const gmail = clones.find((c) => c.label === "gmail")!;
		expect(gmail.bundlePath.endsWith("Claude Account Gmail.app")).toBe(true);
		expect(gmail.storeDir.endsWith("Application Support/Claude-Gmail")).toBe(true);
	});

	it("returns [] when the Applications dir cannot be read", async () => {
		resetMocks(); // readdir rejects by default
		const ports = await makePorts();
		expect(await ports.listCloneApps()).toEqual([]);
	});
});

async function collectEntries(
	iter: AsyncIterable<{ key: Buffer; value: Buffer }>,
): Promise<Array<{ key: Buffer; value: Buffer }>> {
	const out: Array<{ key: Buffer; value: Buffer }> = [];
	for await (const e of iter) {
		out.push(e);
	}
	return out;
}

describe("makeRealDiscoveryPorts.iterateLevelDb + scanV10Values", () => {
	it("scans .log/.ldb files and yields every embedded v10 blob (two hits → sliced at the next prefix)", async () => {
		resetMocks();
		statSpy.mockImplementation(() => Promise.resolve({ isDirectory: () => true }));
		readdirSpy.mockImplementation(() => Promise.resolve(["000005.log", "CURRENT", "LOCK"]));
		// Two v10 blobs back to back plus a trailing one; scanV10Values slices the
		// first up to the second prefix, the last up to EOF.
		const raw = Buffer.concat([
			Buffer.from("junk-header"),
			Buffer.from("v10AAAAAAAA"),
			Buffer.from("v10BBBBBBBB"),
		]);
		readFileSpy.mockImplementation(() => Promise.resolve(raw));
		const ports = await makePorts();
		const out = await collectEntries(ports.iterateLevelDb("/store/leveldb"));
		expect(out).toHaveLength(2);
		expect(out[0]!.value.subarray(0, 3).toString()).toBe("v10");
		expect(out[1]!.value.subarray(0, 3).toString()).toBe("v10");
	});

	it("yields nothing when the file holds no v10 blob", async () => {
		resetMocks();
		statSpy.mockImplementation(() => Promise.resolve({ isDirectory: () => true }));
		readdirSpy.mockImplementation(() => Promise.resolve(["000005.ldb"]));
		readFileSpy.mockImplementation(() => Promise.resolve(Buffer.from("nothing encrypted here")));
		const ports = await makePorts();
		expect(await collectEntries(ports.iterateLevelDb("/store/leveldb"))).toEqual([]);
	});

	it("returns empty when the path is not a directory", async () => {
		resetMocks();
		statSpy.mockImplementation(() => Promise.resolve({ isDirectory: () => false }));
		const ports = await makePorts();
		expect(await collectEntries(ports.iterateLevelDb("/store/leveldb"))).toEqual([]);
	});

	it("returns empty (silent) when the dir is missing", async () => {
		resetMocks(); // stat rejects by default
		const ports = await makePorts();
		expect(await collectEntries(ports.iterateLevelDb("/nope"))).toEqual([]);
	});

	it("warns and skips a file whose read fails, without aborting the dir walk", async () => {
		resetMocks();
		statSpy.mockImplementation(() => Promise.resolve({ isDirectory: () => true }));
		readdirSpy.mockImplementation(() => Promise.resolve(["bad.log", "good.ldb"]));
		readFileSpy.mockImplementation((path: string) =>
			path.endsWith("bad.log")
				? Promise.reject(new Error("EIO"))
				: Promise.resolve(Buffer.concat([Buffer.from("v10"), Buffer.from("CIPHERBYTES")])),
		);
		const warned: string[] = [];
		const ports = await makePorts({
			logger: { log: () => {}, warn: (m: string) => warned.push(m) },
		});
		const out = await collectEntries(ports.iterateLevelDb("/store/leveldb"));
		expect(out).toHaveLength(1);
		expect(warned.some((m) => m.includes("read") && m.includes("failed"))).toBe(true);
	});
});

describe("makeRealDiscoveryPorts.provisionOne", () => {
	it("maps a successful provisionAccount to {ok, uuid} and invokes the synthetic verify", async () => {
		resetMocks();
		let verifiedToken: string | undefined;
		provisionImpl = async (input) => {
			// Exercise the injected syntheticVerify so its uuid/subscription defaults run.
			const verify = (await input.ports.verify(input.token)) as { accountUuid: string };
			verifiedToken = input.token;
			return { ok: true, account: { uuid: verify.accountUuid } };
		};
		const ports = await makePorts();
		const result = await ports.provisionOne({ token: "T-1", label: "gmail" });
		expect(result.ok).toBe(true);
		expect(verifiedToken).toBe("T-1");
		expect((result as { uuid: string }).uuid).toMatch(/^[0-9a-f-]{36}$/u);
	});

	it("maps a failed provisionAccount to {ok:false, kind, detail} with an empty-string detail fallback", async () => {
		resetMocks();
		provisionImpl = () => Promise.resolve({ ok: false, kind: "verify_failed" }); // detail omitted
		const ports = await makePorts();
		const result = await ports.provisionOne({ token: "T-2", label: "work" });
		expect(result).toEqual({ ok: false, kind: "verify_failed", detail: "" });
	});
});
