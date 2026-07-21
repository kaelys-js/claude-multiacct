/**
 * `@foundation/claude-multiacct` — CLI-shim argv + env helpers.
 *
 * Two pure helpers the shim uses on every invocation. Zero I/O so the same
 * functions can be exercised from tests without any mock scaffolding.
 *
 * `parseResumeUuid` extracts the Code session UUID from the CLI argv. Claude
 * Code's desktop launcher passes the session as `--resume=<uuid>` or
 * `--resume <uuid>` anywhere in the argv; we scan both forms and validate the
 * value against `AccountUuidSchema` (the same uuid shape session ids share)
 * before returning. Anything malformed → `undefined`, so the shim's
 * fall-through-to-passthrough path handles it uniformly.
 *
 * `applyTokenSwap` returns a NEW env with the four Anthropic OAuth env vars
 * replaced from the resolved pool account. Every OTHER key in the incoming
 * env is preserved unchanged — that preservation is load-bearing because the
 * shim inherits its whole environment from the desktop launcher (PATH,
 * XPC_SERVICE_NAME, TMPDIR, ...) and losing any of it would break the
 * downstream CLI. Adversarial test: dropping a preserved key must go red.
 *
 * @module
 */

import * as v from "valibot";

/** UUID validator shared with account ids — session ids use the same shape. */
const UuidSchema = v.pipe(v.string(), v.uuid());

/**
 * Extract `--resume`'s UUID value from the CLI argv, or `undefined` if the
 * flag is absent or its value is not a valid uuid. Accepts both the
 * `--resume=UUID` and space-separated `--resume UUID` forms, at any position.
 *
 * @param {readonly string[]} argv - The full argv (including argv[0]/argv[1]).
 * @returns {string | undefined} The valid uuid, or `undefined`.
 */
export function parseResumeUuid(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg !== undefined) {
			if (arg.startsWith("--resume=")) {
				const candidate = arg.slice("--resume=".length);
				return v.safeParse(UuidSchema, candidate).success ? candidate : undefined;
			}
			if (arg === "--resume") {
				const candidate = argv[i + 1];
				if (candidate === undefined) {
					return undefined;
				}
				return v.safeParse(UuidSchema, candidate).success ? candidate : undefined;
			}
		}
	}
	return undefined;
}

/**
 * Account fields the shim needs to swap into the env. Kept structural (rather
 * than importing `Account` from `../domain/account.ts`) so a caller can pass
 * a lean object during tests without minting a full registered account.
 */
export type TokenSwapAccount = {
	oauthToken: string;
	refreshToken?: string;
	subscriptionType?: string;
	rateLimitTier?: string;
};

/** Env keys the shim overwrites; every other key is preserved unchanged. */
const SWAPPED_KEYS = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CODE_SUBSCRIPTION_TYPE",
	"CLAUDE_CODE_RATE_LIMIT_TIER",
] as const;

/**
 * Return a NEW env with the four Anthropic OAuth env vars replaced from
 * `account`; every other key is preserved. Optional account fields that are
 * omitted delete the corresponding env var rather than leaving the caller's
 * primary-account value in place — a partial swap would still identify as
 * the primary to the downstream CLI.
 *
 * @param {Record<string,string>} env - The source env (usually process.env).
 * @param {TokenSwapAccount} account - The pool account to swap in.
 * @returns {Record<string,string>} A new env; input is not mutated.
 */
export function applyTokenSwap(
	env: Record<string, string>,
	account: TokenSwapAccount,
): Record<string, string> {
	const next: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!(SWAPPED_KEYS as readonly string[]).includes(key)) {
			next[key] = value;
		}
	}
	next.CLAUDE_CODE_OAUTH_TOKEN = account.oauthToken;
	if (account.refreshToken !== undefined) {
		next.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = account.refreshToken;
	}
	if (account.subscriptionType !== undefined) {
		next.CLAUDE_CODE_SUBSCRIPTION_TYPE = account.subscriptionType;
	}
	if (account.rateLimitTier !== undefined) {
		next.CLAUDE_CODE_RATE_LIMIT_TIER = account.rateLimitTier;
	}
	return next;
}
