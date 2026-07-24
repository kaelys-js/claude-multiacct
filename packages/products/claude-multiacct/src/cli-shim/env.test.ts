/**
 * Intent: `parseSessionUuid` is the shim's session-id lookup path — the whole
 * choice→account resolution flow depends on it. Claude Code identifies a
 * session with `--session-id <uuid>` (fresh sessions, the case the shim used
 * to miss), `--resume`/`-r` (resumed), in both `=` and space forms at any argv
 * position. The tests pin every form AND assert malformed / missing →
 * `undefined`, because the shim's pass-through fallback relies on that being
 * the negative signal. The `--session-id` cases are the regression guard for
 * the fresh-session gap: drop `--session-id` from the flag list and they trip.
 *
 * `applyTokenSwap` MUST preserve every non-swapped env key and MUST fully own
 * the swapped keys (including `CLAUDE_CONFIG_DIR`, so a swapped session never
 * inherits the launcher's default-identity config dir). The preservation test
 * is deliberately adversarial: it stamps 30 realistic env vars in and asserts
 * every one survives. Inverting the impl to drop e.g. PATH sends the
 * preservation assertion red.
 */

import { describe, expect, it } from "vitest";
import { applyTokenSwap, isInteractiveSession, parseSessionUuid } from "./env.ts";

const VALID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("parseSessionUuid", () => {
	it("finds UUID in --resume=UUID form", () => {
		expect(parseSessionUuid(["node", "claude", `--resume=${VALID}`])).toBe(VALID);
	});

	it("finds UUID in --resume UUID form (space-separated)", () => {
		expect(parseSessionUuid(["node", "claude", "--resume", VALID])).toBe(VALID);
	});

	it("finds UUID in --session-id=UUID form (fresh session — the gap this closes)", () => {
		expect(parseSessionUuid(["node", "claude", `--session-id=${VALID}`])).toBe(VALID);
	});

	it("finds UUID in --session-id UUID form (space-separated)", () => {
		expect(parseSessionUuid(["node", "claude", "--session-id", VALID])).toBe(VALID);
	});

	it("finds UUID in -r UUID form (resume alias)", () => {
		expect(parseSessionUuid(["node", "claude", "-r", VALID])).toBe(VALID);
	});

	it("finds UUID mid-argv, not just at the end", () => {
		expect(parseSessionUuid(["node", "claude", "--flag", `--session-id=${VALID}`, "--other"])).toBe(
			VALID,
		);
	});

	it("resolves the id even when a bare --resume (picker) precedes --session-id", () => {
		// `claude --resume --session-id <uuid>`: bare --resume opens the picker and
		// carries no value; the id arrives via --session-id. A short-circuit on the
		// valueless --resume would wrongly return undefined.
		expect(parseSessionUuid(["node", "claude", "--resume", "--session-id", VALID])).toBe(VALID);
	});

	it("returns undefined when no session flag is present (fallback signal)", () => {
		expect(parseSessionUuid(["node", "claude", "--print"])).toBeUndefined();
	});

	it("returns undefined when the session value is not a valid uuid", () => {
		expect(parseSessionUuid(["node", "claude", "--session-id=not-a-uuid"])).toBeUndefined();
	});

	it("returns undefined when --resume is the trailing arg with no value", () => {
		expect(parseSessionUuid(["node", "claude", "--resume"])).toBeUndefined();
	});

	it("returns the first valid session value when multiple are present", () => {
		expect(parseSessionUuid(["node", "claude", `--resume=${VALID}`, `--session-id=${OTHER}`])).toBe(
			VALID,
		);
	});
});

describe("isInteractiveSession", () => {
	// The real interactive session (the persistent stream-json conversation the
	// launcher drives) always carries --replay-user-messages; the app's
	// short-lived probe spawns never do. Only the former should register for a
	// hot-swap when it arrives id-less, or the probes pollute active resolution.
	const INTERACTIVE = [
		"node",
		"claude",
		"--output-format",
		"stream-json",
		"--input-format",
		"stream-json",
		"--model",
		"claude-opus-4-8",
		"--replay-user-messages",
		"--settings",
		'{"fastMode":false}',
	];
	const PROBE = [
		"node",
		"claude",
		"--output-format",
		"stream-json",
		"--verbose",
		"--input-format",
		"stream-json",
		"--permission-prompt-tool",
		"stdio",
		"--strict-mcp-config",
		"--permission-mode",
		"default",
	];

	it("is true for the persistent interactive session (--replay-user-messages present)", () => {
		expect(isInteractiveSession(INTERACTIVE)).toBe(true);
	});

	it("is false for the app's short-lived probe/preamble spawn", () => {
		expect(isInteractiveSession(PROBE)).toBe(false);
	});

	it("is false for a bare pass-through invocation", () => {
		expect(isInteractiveSession(["node", "claude", "--print", "hi"])).toBe(false);
	});
});

// Realistic 30-key env — the load-bearing preservation assertion tests that
// applyTokenSwap does not touch any of them. If someone reduces this list, the
// adversarial guarantee weakens.
const REALISTIC_ENV: Record<string, string> = {
	PATH: "/usr/bin:/bin",
	HOME: "/Users/dev",
	USER: "dev",
	SHELL: "/bin/zsh",
	TMPDIR: "/var/folders/xx/T/",
	LANG: "en_US.UTF-8",
	LC_ALL: "en_US.UTF-8",
	TERM: "xterm-256color",
	PWD: "/Users/dev",
	OLDPWD: "/Users/dev/prev",
	XPC_SERVICE_NAME: "com.anthropic.claudefordesktop.helper",
	XPC_FLAGS: "0x0",
	__CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
	SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
	LOGNAME: "dev",
	NODE_ENV: "production",
	COLORTERM: "truecolor",
	CLAUDE_CODE_SESSION_ID: "session-xyz",
	CLAUDE_CODE_ENTRYPOINT: "cli",
	CLAUDECODE: "1",
	ANTHROPIC_LOG: "warn",
	CLAUDE_CODE_OAUTH_TOKEN: "primary-token",
	CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "primary-refresh",
	CLAUDE_CODE_SUBSCRIPTION_TYPE: "Pro",
	CLAUDE_CODE_RATE_LIMIT_TIER: "tier-1",
	CLAUDE_CONFIG_DIR: "/Users/dev/.claude-primary",
	FOO: "bar",
	BAZ: "qux",
	NODE_OPTIONS: "--no-warnings",
	npm_config_registry: "https://registry.npmjs.org",
	COREPACK_ENABLE: "0",
};

// The five keys applyTokenSwap fully owns on a swap; every other key is preserved.
const SWAPPED_KEYS = new Set([
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CODE_SUBSCRIPTION_TYPE",
	"CLAUDE_CODE_RATE_LIMIT_TIER",
	"CLAUDE_CONFIG_DIR",
]);

describe("applyTokenSwap", () => {
	const swapped = applyTokenSwap(REALISTIC_ENV, {
		oauthToken: "pool-token",
		refreshToken: "pool-refresh",
		subscriptionType: "Max",
		rateLimitTier: "tier-2",
		configDir: "/Users/dev/.config/claude-multiacct/account-config/acct-2",
	});

	it("replaces the Anthropic OAuth keys with the account's values", () => {
		expect(swapped.CLAUDE_CODE_OAUTH_TOKEN).toBe("pool-token");
		expect(swapped.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("pool-refresh");
		expect(swapped.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe("Max");
		expect(swapped.CLAUDE_CODE_RATE_LIMIT_TIER).toBe("tier-2");
	});

	it("points CLAUDE_CONFIG_DIR at the per-account dir so the session reports the swapped identity", () => {
		expect(swapped.CLAUDE_CONFIG_DIR).toBe(
			"/Users/dev/.config/claude-multiacct/account-config/acct-2",
		);
	});

	it("preserves EVERY non-swapped env key unchanged (load-bearing)", () => {
		// Adversarial: if applyTokenSwap ever starts dropping or mutating a key
		// like PATH, this loop catches it. Compare every non-swapped key to the
		// input by name, not by iterating swapped — the latter would silently
		// pass a "drops keys" regression.
		const preserved = Object.fromEntries(
			Object.entries(REALISTIC_ENV).filter(([key]) => !SWAPPED_KEYS.has(key)),
		);
		const actualPreserved = Object.fromEntries(
			Object.entries(swapped).filter(([key]) => !SWAPPED_KEYS.has(key)),
		);
		expect(actualPreserved).toStrictEqual(preserved);
	});

	it("does not mutate the input env", () => {
		const before = { ...REALISTIC_ENV };
		applyTokenSwap(REALISTIC_ENV, { oauthToken: "x" });
		expect(REALISTIC_ENV).toStrictEqual(before);
	});

	it("omits optional fields (subscriptionType/rateLimitTier/refresh) rather than leaving primary's stale value", () => {
		// The primary's env would carry over if the swap "kept absent keys", so
		// the shim would misidentify as primary. The swap explicitly deletes.
		const partial = applyTokenSwap(REALISTIC_ENV, { oauthToken: "only-token" });
		expect(partial.CLAUDE_CODE_OAUTH_TOKEN).toBe("only-token");
		expect(partial.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBeUndefined();
		expect(partial.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBeUndefined();
		expect(partial.CLAUDE_CODE_RATE_LIMIT_TIER).toBeUndefined();
	});

	it("drops an inherited CLAUDE_CONFIG_DIR when the account has no configDir (no stale primary identity)", () => {
		// REALISTIC_ENV carries a primary CLAUDE_CONFIG_DIR. A token-only swap
		// (configDir omitted) must NOT leak it into the child, or the swapped
		// session would read the primary account's identity from the wrong dir.
		const partial = applyTokenSwap(REALISTIC_ENV, { oauthToken: "only-token" });
		expect(partial.CLAUDE_CONFIG_DIR).toBeUndefined();
	});
});
