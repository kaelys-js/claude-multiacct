/**
 * `@foundation/claude-multiacct` — bridge.json reader for the extension.
 *
 * The daemon (PR5a) writes `{port, secret, version, ...}` to
 * `~/.config/claude-multiacct/bridge.json`. The install step (`installer.ts`)
 * symlinks that path into the unpacked extension directory as `bridge.json`,
 * so the content script reads it via `fetch(chrome.runtime.getURL("bridge.json"))`.
 * That indirection keeps the secret off the wire — the content script never
 * has to read a filesystem, and no page script can steal it via CORS.
 *
 * Failure is a first-class outcome: anything wrong (no file, non-JSON, wrong
 * shape, network error) collapses to `undefined`. The caller (bridge-client)
 * uses that to decide whether to skip the request entirely.
 *
 * @module
 */

import * as v from "valibot";

/**
 * `BridgeConfig` — the subset of the daemon's manifest the extension needs.
 * Non-strict: the daemon also writes `pid` and `startedAt` for its own
 * single-instance bookkeeping, which the extension has no interest in and
 * must not reject on. Validate the three fields we depend on and let the
 * daemon add more as it needs to (Rule 3: extension does not own daemon
 * schema evolution).
 */
export const BridgeConfigSchema = v.object({
	port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
	secret: v.pipe(v.string(), v.minLength(1)),
	version: v.pipe(v.string(), v.minLength(1)),
});
export type BridgeConfig = v.InferOutput<typeof BridgeConfigSchema>;

/** Minimal fetch shape the reader consumes. Matches `globalThis.fetch`. */
export type FetchLike = (url: string) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

/**
 * Fetch and validate `bridge.json` from the extension's own package dir.
 *
 * @param {FetchLike} fetchImpl - Injected fetch (real `fetch` in prod, spy
 *   in tests). Any thrown error → `undefined`.
 * @param {(path: string) => string} extensionUrl - Turns a relative path
 *   into an absolute one inside the extension package
 *   (`chrome.runtime.getURL` in prod).
 * @returns {Promise<BridgeConfig | undefined>} Validated config or `undefined`
 *   on any failure.
 */
export async function readBridgeConfig(
	fetchImpl: FetchLike,
	extensionUrl: (path: string) => string,
): Promise<BridgeConfig | undefined> {
	try {
		const response = await fetchImpl(extensionUrl("bridge.json"));
		if (!response.ok) {
			return undefined;
		}
		const raw = (await response.json()) as unknown;
		const parsed = v.safeParse(BridgeConfigSchema, raw);
		if (!parsed.success) {
			return undefined;
		}
		return parsed.output;
	} catch {
		return undefined;
	}
}
