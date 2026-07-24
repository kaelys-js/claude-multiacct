/**
 * `@foundation/claude-multiacct` — CLI-shim argv + env helpers.
 *
 * Two pure helpers the shim uses on every invocation. Zero I/O so the same
 * functions can be exercised from tests without any mock scaffolding.
 *
 * `parseSessionUuid` extracts the Code session UUID from the CLI argv. Claude
 * Code v2.1.x identifies a session two ways, and the desktop launcher uses
 * both depending on whether the session is new or resumed:
 *   - `--session-id <uuid>` / `--session-id=<uuid>` — pins a FRESH session to a
 *     specific id (what the launcher passes when it opens a new Code session).
 *   - `--resume <uuid>` / `--resume=<uuid>` / `-r <uuid>` — resumes an existing
 *     session by id.
 * We scan every form at any argv position and validate the value against the
 * uuid shape session ids share before returning. Only `--resume`/`-r` take an
 * OPTIONAL value (bare `--resume` opens the interactive picker), so a missing
 * or malformed value there yields `undefined`; `--session-id` always carries a
 * uuid. Anything malformed → `undefined`, so the shim's
 * fall-through-to-passthrough path handles it uniformly.
 *
 * Parsing only `--resume` (the pre-2.1 behaviour) was the fresh-session gap:
 * the picker writes a choice keyed on the session uuid the launcher will pass
 * as `--session-id`, so a shim blind to `--session-id` never engaged the swap
 * for a brand-new session, only for a resumed one.
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

/** Flags whose value is the Code session uuid, longest match tried first. */
const SESSION_FLAGS = ["--session-id", "--resume", "-r"] as const;

/**
 * Extract the Code session UUID from the CLI argv, or `undefined` when no
 * session flag carries a valid uuid. Handles both `--flag=UUID` and the
 * space-separated `--flag UUID` forms, at any argv position, for every flag
 * Claude Code uses to identify a session: `--session-id` (fresh sessions),
 * `--resume` and its `-r` alias (resumed sessions).
 *
 * The first flag that resolves to a valid uuid wins; a flag present with a
 * missing or malformed value is skipped rather than short-circuiting to
 * `undefined`, so `claude --resume --session-id <uuid>` (bare `--resume`
 * opening the picker, id supplied separately) still resolves the id.
 *
 * @param {readonly string[]} argv - The full argv (including argv[0]/argv[1]).
 * @returns {string | undefined} The valid uuid, or `undefined`.
 */
export function parseSessionUuid(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg !== undefined) {
			for (const flag of SESSION_FLAGS) {
				const eq = `${flag}=`;
				if (arg.startsWith(eq)) {
					const candidate = arg.slice(eq.length);
					if (v.safeParse(UuidSchema, candidate).success) {
						return candidate;
					}
				} else if (arg === flag) {
					const candidate = argv[i + 1];
					if (candidate !== undefined && v.safeParse(UuidSchema, candidate).success) {
						return candidate;
					}
				}
			}
		}
	}
	return undefined;
}

/**
 * Marker flag the desktop launcher passes ONLY on the persistent
 * conversation-driving Code session — the long-lived `stream-json` process
 * that owns the tab's transcript. Probe/preamble spawns (the short-lived
 * `--strict-mcp-config … --permission-mode default` invocations the app fires
 * for capability checks) never carry it.
 */
const INTERACTIVE_MARKER = "--replay-user-messages";

/**
 * True iff `argv` is the app's real interactive Code session (as opposed to a
 * short-lived probe/preamble spawn). Used by the shim to decide whether a
 * fresh session — one the launcher spawned with NO `--session-id`/`--resume`
 * in argv (the app keys such sessions only on the `CLAUDE_CODE_HOST_SESSION_ID`
 * env var, a different namespace than the CLI uuid) — should mint its own
 * session id so it becomes targetable for a hot-swap. Probe spawns must NOT
 * register, or they pollute active-session resolution.
 *
 * @param {readonly string[]} argv - The full argv (including argv[0]/argv[1]).
 * @returns {boolean} Whether this is the persistent interactive session.
 */
export function isInteractiveSession(argv: readonly string[]): boolean {
	return argv.includes(INTERACTIVE_MARKER);
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
	/**
	 * Per-account config directory. When present, the swap sets
	 * `CLAUDE_CONFIG_DIR` to it so the downstream CLI reads (and populates) an
	 * identity separate from the default `~/.claude.json`. This is what makes
	 * the account the model REPORTS match the swapped token: Claude Code fetches
	 * the profile for `CLAUDE_CODE_OAUTH_TOKEN` and persists it into this dir's
	 * `.claude.json`, keeping each session's identity isolated without ever
	 * writing the shared global config. Omitted → `CLAUDE_CONFIG_DIR` is left
	 * out of the swapped env (the pass-through/default-identity behaviour).
	 */
	configDir?: string;
};

/**
 * Env keys the shim fully controls on a swap; every other key is preserved
 * unchanged. `CLAUDE_CONFIG_DIR` is included so a swap deterministically owns
 * the config dir — an inherited value is dropped and re-set (or removed) from
 * the account, never left to leak the launcher's default identity into a
 * swapped session.
 */
const SWAPPED_KEYS = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CODE_SUBSCRIPTION_TYPE",
	"CLAUDE_CODE_RATE_LIMIT_TIER",
	"CLAUDE_CONFIG_DIR",
] as const;

/**
 * Return a NEW env with the Anthropic OAuth env vars replaced from `account`;
 * every other key is preserved. Optional account fields that are omitted delete
 * the corresponding env var rather than leaving the caller's primary-account
 * value in place — a partial swap would still identify as the primary to the
 * downstream CLI. When `account.configDir` is set, `CLAUDE_CONFIG_DIR` points
 * the CLI at that per-account dir so its reported identity matches the swap.
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
	if (account.configDir !== undefined) {
		next.CLAUDE_CONFIG_DIR = account.configDir;
	}
	return next;
}
