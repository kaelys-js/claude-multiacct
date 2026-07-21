/**
 * `@foundation/claude-multiacct` — bridge HTTP client for the extension.
 *
 * Wraps every daemon call with the shared-secret header (`x-cma-bridge-secret`)
 * and a single-shot retry on 401 — the daemon rotates its secret on every
 * start, so a stale cached config produces exactly one 401, one bridge.json
 * refetch, and one retry. Two 401s in a row means the extension's own
 * bridge.json really is stale (installer would fix that) or the daemon's
 * secret pipeline is broken; either way, surface as `unauthorized` so the
 * caller can show a state, not silently spin.
 *
 * The result type is discriminated instead of `throw` so DOM callers don't
 * have to try/catch every request path — Rule 12: the failure kind travels
 * with the value.
 *
 * @module
 */

import { type BridgeConfig, type FetchLike, readBridgeConfig } from "./bridge-config.ts";

/** Failure kinds surfaced to picker/usage UI. */
export type BridgeErrorKind = "network" | "unauthorized" | "malformed" | "unexpected";

/** Result shape — success or classified failure. */
export type BridgeResult<T> =
	| { ok: true; data: T }
	| { ok: false; kind: BridgeErrorKind; detail: string };

/** Fetch shape needed for bodies + headers — a superset of `FetchLike`. */
export type FetchWithHeaders = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

export type BridgeClient = {
	get<T = unknown>(path: string): Promise<BridgeResult<T>>;
	post<T = unknown>(path: string, body: unknown): Promise<BridgeResult<T>>;
};

export type CreateBridgeClientOptions = {
	fetchImpl: FetchWithHeaders;
	extensionUrl: (path: string) => string;
	/** Seeded config; skipped-then-refetched if absent. */
	config?: BridgeConfig;
};

/** Header the daemon (PR5a security.ts) expects. Kept in a constant here so
 *  a header-rename in one repo layer breaks the whole call chain visibly. */
export const BRIDGE_SECRET_HEADER = "x-cma-bridge-secret";

/**
 * Build a client. Callers create one per script activation; the closed-over
 * `config` mutates when a 401 forces a refetch.
 *
 * @param {CreateBridgeClientOptions} opts - Injected fetch + url resolver.
 * @returns {BridgeClient} A get/post facade.
 */
export function createBridgeClient(opts: CreateBridgeClientOptions): BridgeClient {
	let cached: BridgeConfig | undefined = opts.config;

	async function ensureConfig(): Promise<BridgeConfig | undefined> {
		if (cached !== undefined) {
			return cached;
		}
		cached = await readBridgeConfig(opts.fetchImpl as FetchLike, opts.extensionUrl);
		return cached;
	}

	async function doFetch<T>(
		path: string,
		method: "GET" | "POST",
		body: unknown | undefined,
		config: BridgeConfig,
	): Promise<BridgeResult<T> | { retryAuth: true }> {
		const url = `http://127.0.0.1:${config.port}${path}`;
		try {
			const response = await opts.fetchImpl(url, {
				method,
				headers: {
					[BRIDGE_SECRET_HEADER]: config.secret,
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.status === 401) {
				return { retryAuth: true };
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch (parseError) {
				return {
					ok: false,
					kind: "malformed",
					detail: `non-json response: ${(parseError as Error).message}`,
				};
			}
			if (!response.ok) {
				return {
					ok: false,
					kind: "unexpected",
					detail: `http ${response.status}: ${JSON.stringify(payload)}`,
				};
			}
			return { ok: true, data: payload as T };
		} catch (error) {
			return { ok: false, kind: "network", detail: (error as Error).message };
		}
	}

	async function request<T>(
		path: string,
		method: "GET" | "POST",
		body: unknown | undefined,
	): Promise<BridgeResult<T>> {
		let config = await ensureConfig();
		if (config === undefined) {
			return { ok: false, kind: "network", detail: "bridge.json unavailable" };
		}
		const first = await doFetch<T>(path, method, body, config);
		if ("retryAuth" in first) {
			// Force a bridge.json refetch (secret may have rotated).
			cached = undefined;
			config = await ensureConfig();
			if (config === undefined) {
				return { ok: false, kind: "unauthorized", detail: "bridge.json unavailable on retry" };
			}
			const second = await doFetch<T>(path, method, body, config);
			if ("retryAuth" in second) {
				return { ok: false, kind: "unauthorized", detail: "401 after secret refetch" };
			}
			return second;
		}
		return first;
	}

	return {
		get<T = unknown>(path: string): Promise<BridgeResult<T>> {
			return request<T>(path, "GET", undefined);
		},
		post<T = unknown>(path: string, body: unknown): Promise<BridgeResult<T>> {
			return request<T>(path, "POST", body);
		},
	};
}
