/**
 * Intent: `parseResumeUuid` is the shim's session-id lookup path — the whole
 * choice→account resolution flow depends on it. The tests pin the three
 * forms Claude Code actually emits (`--resume=UUID`, `--resume UUID`,
 * mid-argv) AND assert malformed / missing → `undefined`, because the shim's
 * pass-through fallback relies on that being the negative signal.
 *
 * `applyTokenSwap` MUST preserve every non-swapped env key. The preservation
 * test is deliberately adversarial: it stamps 30 realistic env vars in and
 * asserts every one survives. Inverting the impl to drop e.g. PATH sends the
 * preservation assertion red — a test that couldn't fail on that mutation
 * would not be testing preservation, only replacement.
 */

import { describe, expect, it } from "vitest";
import { applyTokenSwap, parseResumeUuid } from "./env.ts";

const VALID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("parseResumeUuid", () => {
	it("finds UUID in --resume=UUID form", () => {
		expect(parseResumeUuid(["node", "claude", `--resume=${VALID}`])).toBe(VALID);
	});

	it("finds UUID in --resume UUID form (space-separated)", () => {
		expect(parseResumeUuid(["node", "claude", "--resume", VALID])).toBe(VALID);
	});

	it("finds UUID mid-argv, not just at the end", () => {
		expect(parseResumeUuid(["node", "claude", "--flag", `--resume=${VALID}`, "--other"])).toBe(
			VALID,
		);
	});

	it("returns undefined when --resume is absent (fallback signal)", () => {
		expect(parseResumeUuid(["node", "claude", "--print"])).toBeUndefined();
	});

	it("returns undefined when --resume value is not a valid uuid", () => {
		expect(parseResumeUuid(["node", "claude", "--resume=not-a-uuid"])).toBeUndefined();
	});

	it("returns undefined when --resume is the trailing arg with no value", () => {
		expect(parseResumeUuid(["node", "claude", "--resume"])).toBeUndefined();
	});

	it("returns the first --resume value when multiple are present", () => {
		expect(parseResumeUuid(["node", "claude", `--resume=${VALID}`, `--resume=${OTHER}`])).toBe(
			VALID,
		);
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
	FOO: "bar",
	BAZ: "qux",
	NODE_OPTIONS: "--no-warnings",
	npm_config_registry: "https://registry.npmjs.org",
	COREPACK_ENABLE: "0",
};

describe("applyTokenSwap", () => {
	const swapped = applyTokenSwap(REALISTIC_ENV, {
		oauthToken: "pool-token",
		refreshToken: "pool-refresh",
		subscriptionType: "Max",
		rateLimitTier: "tier-2",
	});

	it("replaces the four Anthropic OAuth keys with the account's values", () => {
		expect(swapped.CLAUDE_CODE_OAUTH_TOKEN).toBe("pool-token");
		expect(swapped.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("pool-refresh");
		expect(swapped.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe("Max");
		expect(swapped.CLAUDE_CODE_RATE_LIMIT_TIER).toBe("tier-2");
	});

	it("preserves EVERY non-swapped env key unchanged (load-bearing)", () => {
		// Adversarial: if applyTokenSwap ever starts dropping or mutating a key
		// like PATH, this loop catches it. Compare every non-swapped key to the
		// input by name, not by iterating swapped — the latter would silently
		// pass a "drops keys" regression.
		const swappedKeys = new Set([
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
			"CLAUDE_CODE_SUBSCRIPTION_TYPE",
			"CLAUDE_CODE_RATE_LIMIT_TIER",
		]);
		const preserved = Object.fromEntries(
			Object.entries(REALISTIC_ENV).filter(([key]) => !swappedKeys.has(key)),
		);
		const actualPreserved = Object.fromEntries(
			Object.entries(swapped).filter(([key]) => !swappedKeys.has(key)),
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
});
