/**
 * Intent: the bridge client wraps every daemon call with the shared
 * secret header AND recovers on exactly one 401 by refetching the
 * (rotated) bridge.json. That single-shot retry is the only reason
 * the extension survives a daemon restart mid-session; without it
 * every user would need to reload the tab after each rotation.
 * Adversarial: remove the refetch — the "rotated secret recovers on
 * next call" test flips red.
 */

import { describe, expect, it, vi } from "vitest";
import { BRIDGE_SECRET_HEADER, createBridgeClient } from "./bridge-client.ts";

type FetchArgs = { url: string; init: any };
type MockFetch = (
	url: string,
	init?: any,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function makeFetch(responses: Array<{ status: number; body?: unknown; throwErr?: Error }>): {
	fn: ReturnType<typeof vi.fn<MockFetch>>;
	calls: FetchArgs[];
} {
	const calls: FetchArgs[] = [];
	let i = 0;
	const fn = vi.fn<MockFetch>((url: string, init?: any) => {
		calls.push({ url, init });
		const r = responses[i++];
		if (r === undefined) {
			return Promise.reject(new Error("unexpected extra call"));
		}
		if (r.throwErr !== undefined) {
			return Promise.reject(r.throwErr);
		}
		return Promise.resolve({
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			json: () => {
				if (r.body === "__notjson__") {
					return Promise.reject(new Error("not json"));
				}
				return Promise.resolve(r.body);
			},
		});
	});
	return { fn, calls };
}

const extUrl = (p: string): string => `chrome-extension://x/${p}`;
const seeded = { port: 9000, secret: "s1", version: "v" };

describe("bridge-client", () => {
	it("attaches the shared-secret header and hits the loopback port", async () => {
		const { fn, calls } = makeFetch([{ status: 200, body: { ok: true, hi: 1 } }]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.get("/health");
		expect(result).toEqual({ ok: true, data: { ok: true, hi: 1 } });
		expect(calls[0]?.url).toBe("http://127.0.0.1:9000/health");
		expect(calls[0]?.init?.headers?.[BRIDGE_SECRET_HEADER]).toBe("s1");
	});

	it("serializes POST bodies to JSON with content-type set", async () => {
		const { fn, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		await client.post("/choice/abc", { accountUuid: "u" });
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.body).toBe(JSON.stringify({ accountUuid: "u" }));
	});

	it("del issues a DELETE with the secret header and no body (account-remove path)", async () => {
		const { fn, calls } = makeFetch([{ status: 200, body: { ok: true, removed: { label: "x" } } }]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.del("/accounts/abc");
		expect(result).toEqual({ ok: true, data: { ok: true, removed: { label: "x" } } });
		expect(calls[0]?.url).toBe("http://127.0.0.1:9000/accounts/abc");
		expect(calls[0]?.init?.method).toBe("DELETE");
		expect(calls[0]?.init?.body).toBeUndefined();
		expect(calls[0]?.init?.headers?.[BRIDGE_SECRET_HEADER]).toBe("s1");
	});

	it("refetches bridge.json on 401 and recovers with the rotated secret", async () => {
		const rotated = { port: 9000, secret: "s2", version: "v" };
		const { fn, calls } = makeFetch([
			{ status: 401, body: { ok: false } }, // first attempt with stale secret
			{ status: 200, body: rotated }, // refetch bridge.json
			{ status: 200, body: { ok: true, healed: true } }, // retry
		]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.get("/accounts");
		expect(result).toEqual({ ok: true, data: { ok: true, healed: true } });
		expect(calls[0]?.init?.headers?.[BRIDGE_SECRET_HEADER]).toBe("s1");
		expect(calls[2]?.init?.headers?.[BRIDGE_SECRET_HEADER]).toBe("s2");
	});

	it("returns unauthorized after a second 401", async () => {
		const { fn } = makeFetch([
			{ status: 401, body: {} },
			{ status: 200, body: seeded },
			{ status: 401, body: {} },
		]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.get("/x");
		expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
	});

	it("classifies fetch throws as network errors", async () => {
		const { fn } = makeFetch([{ status: 0, throwErr: new Error("boom") }]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.get("/x");
		expect(result).toMatchObject({ ok: false, kind: "network" });
	});

	it("classifies non-JSON responses as malformed", async () => {
		const { fn } = makeFetch([{ status: 200, body: "__notjson__" }]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.get("/x");
		expect(result).toMatchObject({ ok: false, kind: "malformed" });
	});

	it("classifies non-2xx (not 401) as unexpected", async () => {
		const { fn } = makeFetch([{ status: 500, body: { ok: false } }]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.get("/x");
		expect(result).toMatchObject({ ok: false, kind: "unexpected" });
	});

	it("bootstraps bridge.json when no config is seeded", async () => {
		const { fn, calls } = makeFetch([
			{ status: 200, body: seeded }, // bridge.json load
			{ status: 200, body: { ok: true } }, // actual request
		]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl });
		const result = await client.get("/accounts");
		expect(result.ok).toBe(true);
		expect(calls[0]?.url).toBe("chrome-extension://x/bridge.json");
	});

	it("returns network error when bridge.json cannot be bootstrapped", async () => {
		const { fn } = makeFetch([
			{ status: 200, body: null }, // bridge.json parse yields null -> schema fails -> undefined
		]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl });
		const result = await client.get("/accounts");
		expect(result).toMatchObject({ ok: false, kind: "network" });
	});

	it("returns unauthorized when bridge.json is unavailable on the retry path", async () => {
		const { fn } = makeFetch([
			{ status: 401, body: {} }, // first request 401
			{ status: 200, body: null }, // refetch bridge.json fails validation
		]);
		const client = createBridgeClient({ fetchImpl: fn, extensionUrl: extUrl, config: seeded });
		const result = await client.get("/x");
		expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
	});
});
