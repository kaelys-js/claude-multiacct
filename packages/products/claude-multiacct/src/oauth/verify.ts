/**
 * `@foundation/claude-multiacct` — OAuth token verify.
 *
 * `verifyToken` proves a caller-supplied OAuth token belongs to a real
 * Anthropic account BEFORE anything is written to the pool. It spawns the
 * repo's stock `claude.real` (path is injected — see `verifyToken`'s
 * `claudeRealPath`) with `CLAUDE_CODE_OAUTH_TOKEN=<token>` and asks the CLI
 * for its account identity + tier. Success → the identity fields the
 * registry needs (uuid, subscription, tier). Failure → a *classified* kind
 * so provisioning can report the specific cause (Rule 12).
 *
 * # Probe subcommand (TODO(pr5))
 *
 * We do not yet have a pinned `claude` subcommand that reliably prints
 * identity JSON without side effects. `usage` is the current best guess
 * (the CLI's `/usage` slash-command surfaces subscription + rate-limit
 * data). PR5 will pin this against real CLI output; until then the caller
 * can override via `probeArgs` and tests exercise the parse via injected
 * fake output, so the code path is fully covered even before the exact
 * subcommand is settled.
 *
 * # OAuth token endpoint (unused here — see `./refresh.ts`)
 *
 * # Error classification
 *
 * - `unauthorized` — CLI exits with the "not authenticated" family (exit 401,
 *   or stderr containing an auth-failure marker). Load-bearing because
 *   provisioning must reject verify-failed tokens with an operator-actionable
 *   kind ("your token is bad"), not conflate it with a network glitch.
 * - `network` — spawn returned ENETUNREACH / ETIMEDOUT, or the exec impl
 *   throws with a matching errno-shaped `code`.
 * - `malformed` — CLI exited 0 but stdout did not parse as JSON of the
 *   expected shape.
 * - `unexpected` — anything else. A caller should surface the raw detail.
 *
 * `exec` is INJECTED (a `spawnFn` port) so tests never shell out.
 *
 * @module
 */

import * as v from "valibot";
import type { VerifyResult } from "./models.ts";

/**
 * Coerce a throwable into a printable string. Single branch for coverage.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Injected process-spawn surface. Test-friendly minimal shape. */
export type VerifyExec = (
	file: string,
	args: readonly string[],
	options: { env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number; error?: NodeJS.ErrnoException }>;

/** `verifyToken` args. */
export type VerifyOptions = {
	/** The OAuth token to prove (`sk-ant-oat01-…` or a `claude login` result). */
	token: string;
	/** Absolute path to the stock CLI (`.../MacOS/claude.real`). */
	claudeRealPath: string;
	/** Injected exec. */
	exec: VerifyExec;
	/** Timeout for the probe subprocess (default 10s). */
	timeoutMs?: number;
	/**
	 * Override the probe argv. Defaults to `["usage"]`. TODO(pr5): pin against
	 * real CLI output; the current default is a best-guess from CLI docs.
	 */
	probeArgs?: readonly string[];
};

/** Shape we parse out of the CLI's stdout. Extra fields tolerated. */
const ProbeStdoutSchema = v.object({
	subscriptionType: v.pipe(v.string(), v.minLength(1)),
	rateLimitTier: v.pipe(v.string(), v.minLength(1)),
	accountUuid: v.pipe(v.string(), v.uuid()),
	orgUuid: v.optional(v.pipe(v.string(), v.uuid())),
});

const NETWORK_ERRNOS = new Set([
	"ENETUNREACH",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET",
	"EAI_AGAIN",
	"ENOTFOUND",
	"EHOSTUNREACH",
]);

function classifyExecError(err: NodeJS.ErrnoException): "network" | "unexpected" {
	if (err.code !== undefined && NETWORK_ERRNOS.has(err.code)) {
		return "network";
	}
	return "unexpected";
}

function looksLikeAuthFailure(stderr: string): boolean {
	// The CLI prints a variety of auth-failure banners; match the words that
	// consistently appear regardless of subcommand.
	return /unauthori[sz]ed|not\s+authenticated|invalid\s+token|401/iu.test(stderr);
}

/**
 * Verify `token` by spawning `claudeRealPath` with the token in env and
 * parsing its identity JSON. See module docstring for the error taxonomy.
 *
 * @param {VerifyOptions} opts - Verify inputs; `exec` is injected.
 * @returns {Promise<VerifyResult>} Ok with identity fields, or classified error.
 */
export async function verifyToken(opts: VerifyOptions): Promise<VerifyResult> {
	const { token, claudeRealPath, exec, timeoutMs = 10_000, probeArgs = ["usage"] } = opts;

	// Only *add* the token env var — every other var (PATH, HOME, TMPDIR, …)
	// is inherited unchanged so the CLI's runtime finds its own resources.
	const env: Record<string, string | undefined> = {
		...process.env,
		CLAUDE_CODE_OAUTH_TOKEN: token,
	};

	let outcome: { stdout: string; stderr: string; exitCode: number; error?: NodeJS.ErrnoException };
	try {
		outcome = await exec(claudeRealPath, probeArgs, { env, timeoutMs });
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		const kind = classifyExecError(err);
		return { ok: false, kind, detail: errMsg(err) };
	}

	if (outcome.error !== undefined) {
		const kind = classifyExecError(outcome.error);
		return { ok: false, kind, detail: errMsg(outcome.error) };
	}

	if (outcome.exitCode === 401 || looksLikeAuthFailure(outcome.stderr)) {
		return {
			ok: false,
			kind: "unauthorized",
			detail: outcome.stderr.trim() || `probe exited ${outcome.exitCode}`,
		};
	}

	if (outcome.exitCode !== 0) {
		return {
			ok: false,
			kind: "unexpected",
			detail: `probe exited ${outcome.exitCode}: ${outcome.stderr.trim()}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(outcome.stdout);
	} catch (error) {
		return {
			ok: false,
			kind: "malformed",
			detail: `probe stdout was not JSON: ${errMsg(error)}`,
		};
	}

	const validated = v.safeParse(ProbeStdoutSchema, parsed);
	if (!validated.success) {
		return {
			ok: false,
			kind: "malformed",
			detail: `probe stdout did not match expected shape: ${validated.issues[0].message}`,
		};
	}
	const { subscriptionType, rateLimitTier, accountUuid, orgUuid } = validated.output;
	return orgUuid === undefined
		? { ok: true, subscriptionType, rateLimitTier, accountUuid }
		: { ok: true, subscriptionType, rateLimitTier, accountUuid, orgUuid };
}
