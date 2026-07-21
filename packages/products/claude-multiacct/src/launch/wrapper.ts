/**
 * `@foundation/claude-multiacct` — Claude.app launcher wrapper.
 *
 * `launchClaude` spawns the macOS `open` binary against
 * `/Applications/Claude.app` (path injectable for tests) with the
 * blackhole `--host-resolver-rules` argv and `REACT_PROFILE=1` in the
 * env. That env var is Claude Desktop's dev hook to `loadExtension`
 * from a filesystem path — PR5b relies on this env being present, so
 * losing it silently would render the extension undiscoverable.
 *
 * `/Applications/Claude.app` is NEVER modified. We just `open -a` it
 * with extra argv; Claude passes those through to its Electron main
 * process. This is the design goal of PR5a: the desktop bundle stays
 * pristine.
 *
 * `spawnFn` is injected so unit tests can assert exact argv and env
 * without spawning the real app.
 *
 * @module
 */

import { stat } from "node:fs/promises";
import { CWS_ENDPOINTS, renderHostResolverRules } from "./host-resolver.ts";

/** Default install location of Claude Desktop on macOS. */
export const DEFAULT_APP_PATH = "/Applications/Claude.app";

/** Minimal `spawn`-shape the wrapper needs. Test-injectable. */
export type SpawnFn = (
	file: string,
	args: readonly string[],
	options: { env: NodeJS.ProcessEnv },
) => void;

/** `launchClaude` args. */
export type LaunchOptions = {
	spawnFn: SpawnFn;
	env: NodeJS.ProcessEnv;
	appPath?: string;
	/** `stat`-shape for existence check; defaults to `node:fs/promises`. */
	statFn?: (path: string) => Promise<unknown>;
};

/** `launchClaude` result. */
export type LaunchResult = { launched: true; argv: readonly string[] };

/**
 * Spawn `open -a <appPath> --args …` with `REACT_PROFILE=1` set.
 *
 * @param {LaunchOptions} opts - Injected deps + overrides.
 * @returns {Promise<LaunchResult>} `{launched:true, argv}` — argv echoed for logging/tests.
 */
export async function launchClaude(opts: LaunchOptions): Promise<LaunchResult> {
	const appPath = opts.appPath ?? DEFAULT_APP_PATH;
	const statFn = opts.statFn ?? stat;
	try {
		await statFn(appPath);
	} catch (error) {
		throw new Error(`launchClaude: appPath does not exist: ${appPath}`, { cause: error });
	}
	const rules = renderHostResolverRules(CWS_ENDPOINTS);
	const argv = ["-a", appPath, "--args", `--host-resolver-rules=${rules}`] as const;
	const env: NodeJS.ProcessEnv = { ...opts.env, REACT_PROFILE: "1" };
	opts.spawnFn("open", argv, { env });
	return { launched: true, argv };
}
