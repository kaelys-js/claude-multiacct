/**
 * Intent: `readBridgeConfig` is the extension's only path to the daemon's
 * shared secret. It MUST return `undefined` — not throw, not partial —
 * for every plausible failure mode, because a thrown value here breaks
 * the content-script boot and leaves the whole tab silent. It MUST also
 * accept the daemon's real write-shape (which carries `pid` + `startedAt`
 * for single-instance bookkeeping the extension doesn't care about) —
 * strictObject rejects those and produced a silent no-picker in prod.
 * Adversarial: flip `object` back to `strictObject` and the
 * "accepts daemon-shape with pid+startedAt" test flips RED.
 */

import { describe, expect, it, vi } from "vitest";
import { type FetchLike, readBridgeConfig } from "./bridge-config.ts";

function ok(body: unknown): ReturnType<FetchLike> {
	return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

const url = (path: string): string => `chrome-extension://x/${path}`;

describe("readBridgeConfig", () => {
	it("returns the validated config on a happy fetch", async () => {
		const fetchImpl = vi.fn<FetchLike>(() => ok({ port: 9001, secret: "abc", version: "0.0.0" }));
		const result = await readBridgeConfig(fetchImpl as unknown as FetchLike, url);
		expect(result).toEqual({ port: 9001, secret: "abc", version: "0.0.0" });
		expect(fetchImpl).toHaveBeenCalledWith("chrome-extension://x/bridge.json");
	});

	it("returns undefined when fetch throws (bridge.json missing)", async () => {
		const fetchImpl = vi.fn<FetchLike>(() => Promise.reject(new Error("ENOENT")));
		expect(await readBridgeConfig(fetchImpl as unknown as FetchLike, url)).toBeUndefined();
	});

	it("returns undefined when response.ok is false", async () => {
		const fetchImpl = vi.fn<FetchLike>(() =>
			Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
		);
		expect(await readBridgeConfig(fetchImpl as unknown as FetchLike, url)).toBeUndefined();
	});

	it("returns undefined when JSON.parse throws (malformed body)", async () => {
		const fetchImpl = vi.fn<FetchLike>(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.reject(new Error("bad json")),
			}),
		);
		expect(await readBridgeConfig(fetchImpl as unknown as FetchLike, url)).toBeUndefined();
	});

	it("returns undefined when schema validation fails (missing secret)", async () => {
		const fetchImpl = vi.fn<FetchLike>(() => ok({ port: 9001, version: "0.0.0" }));
		expect(await readBridgeConfig(fetchImpl as unknown as FetchLike, url)).toBeUndefined();
	});

	it("accepts daemon-shape with pid+startedAt (extra fields the daemon writes)", async () => {
		const fetchImpl = vi.fn<FetchLike>(() =>
			ok({
				port: 65_336,
				secret: "example-fixture-secret-not-real",
				version: "0.0.0",
				pid: 98_361,
				startedAt: "2026-07-21T05:21:27.029Z",
			}),
		);
		const result = await readBridgeConfig(fetchImpl as unknown as FetchLike, url);
		expect(result).toEqual({
			port: 65_336,
			secret: "example-fixture-secret-not-real",
			version: "0.0.0",
		});
	});

	it("rejects a port outside 1..65535", async () => {
		const fetchImpl = vi.fn<FetchLike>(() => ok({ port: 0, secret: "s", version: "v" }));
		expect(await readBridgeConfig(fetchImpl as unknown as FetchLike, url)).toBeUndefined();
	});
});
