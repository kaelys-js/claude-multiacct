/**
 * `@foundation/claude-multiacct` — `cma launch`.
 *
 * Thin verifier around PR5a's `launchClaude`:
 *
 *   1. `/Applications/Claude.app` exists (fail loud if not).
 *   2. Bridge daemon liveness — `bridge.json` exists, parses under the
 *      structural schema (valibot), AND its `pid` responds to `kill(pid,0)`.
 *      Failure prints an actionable bootstrap command instead of "unknown
 *      error".
 *   3. Delegate to `launchClaude` with `bridgeJsonPath` from config.
 *
 * Liveness proof: valid `bridge.json` structure + `process.kill(pid, 0)`.
 * The daemon writes `bridge.json` once at boot (`http-bridge/server.ts::start`)
 * and does not rewrite it on a keepalive tick — an mtime freshness gate
 * would refuse a healthy daemon whose sidecar is just old. PID-scoped
 * liveness under `gui/<uid>` is enough; stale-PID reuse in that scope is
 * negligible.
 *
 * @module
 */

import * as v from "valibot";
import type { CmaConfig } from "../config-store.ts";

/**
 * Structural schema for the launch-side view of `bridge.json`. Rejects a
 * corrupted / partial sidecar loudly rather than proceeding with a bogus
 * pid. Deliberately narrower than `http-bridge/server.ts`'s `BridgeManifest`
 * so a manifest-field addition does not force a launch-side edit; launch
 * only reads `pid`.
 */
export const BridgeSidecarSchema = v.object({
	pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type BridgeSidecar = v.InferOutput<typeof BridgeSidecarSchema>;

/** Ports for `launchCommand`. */
export type LaunchPorts = {
	/** Config → `bridgeJsonPath`. Undefined means "no config yet". */
	readConfig: () => Promise<CmaConfig | undefined>;
	/** Async fs surface — stat + readFile only. `stat` used solely to prove Claude.app presence. */
	fs: {
		stat: (path: string) => Promise<{ mtimeMs: number }>;
		readFile: (path: string) => Promise<string>;
	};
	/**
	 * Signal-check port. Real impl: `(pid) => { process.kill(pid, 0);
	 * return true; }` inside a try/catch. Injected so tests can mock
	 * dead-daemon scenarios.
	 */
	pidIsAlive: (pid: number) => boolean;
	/**
	 * PR5a's `launchClaude` port. Signature narrowed here to the two
	 * fields this command needs.
	 */
	launchClaude: (args: { bridgeJsonPath: string }) => Promise<void>;
	/** `/Applications/Claude.app` path — injected so tests can point at a fixture. */
	appPath: string;
	logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

/** Result of `launchCommand`. */
export type LaunchResult = {
	exitCode: number;
	reason?: string;
};

/**
 * `cma launch`. See module docstring.
 *
 * @param {LaunchPorts} ports - Injected surface.
 * @returns {Promise<LaunchResult>} `exitCode: 0` on success.
 */
export async function launchCommand(ports: LaunchPorts): Promise<LaunchResult> {
	// (1) Claude.app must exist.
	try {
		await ports.fs.stat(ports.appPath);
	} catch {
		const reason = `cma launch: ${ports.appPath} not found; install Claude Desktop first`;
		ports.logger.error(reason);
		return { exitCode: 2, reason };
	}

	// Load config for bridgeJsonPath.
	const cfg = await ports.readConfig();
	if (cfg === undefined) {
		const reason = "cma launch: config.json missing; run `cma init` and `cma install` first";
		ports.logger.error(reason);
		return { exitCode: 2, reason };
	}

	// (2) Daemon liveness — read + structural validate + pid probe.
	const bridgePath = cfg.bridgeJsonPath;
	let raw: string;
	try {
		raw = await ports.fs.readFile(bridgePath);
	} catch {
		return refuseDaemon(ports, "bridge.json missing or unreadable");
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return refuseDaemon(ports, "bridge.json is not valid JSON");
	}
	const validated = v.safeParse(BridgeSidecarSchema, parsedJson);
	if (!validated.success) {
		return refuseDaemon(ports, "bridge.json failed structural validation");
	}
	const { pid } = validated.output;
	if (!ports.pidIsAlive(pid)) {
		return refuseDaemon(ports, `daemon pid ${String(pid)} is not alive`);
	}

	// (3) Delegate.
	await ports.launchClaude({ bridgeJsonPath: bridgePath });
	ports.logger.log(`cma launch: launched ${ports.appPath}`);
	return { exitCode: 0 };
}

/**
 * Print the actionable bootstrap hint and return the refusal result.
 *
 * @param {LaunchPorts} ports - Ports (for logger + uid interpolation).
 * @param {string} why - Concrete reason for the refusal.
 * @returns {LaunchResult} Refusal shape with exit 2.
 */
function refuseDaemon(ports: LaunchPorts, why: string): LaunchResult {
	const reason = `cma launch: ${why}`;
	ports.logger.error(reason);
	ports.logger.error(
		"daemon not running; run: launchctl bootstrap gui/$UID $HOME/Library/LaunchAgents/com.claude-multiacct.bridge-daemon.plist  # or: cma install",
	);
	return { exitCode: 2, reason };
}
