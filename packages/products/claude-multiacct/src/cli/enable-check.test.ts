/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `isEnabled` is the OR of env + config.enabled. Load-bearing:
 *
 *   - env-only true, config-only true, both true → true; neither → false.
 *   - Adversarial: swap the OR to AND → the env-only-true and
 *     config-only-true cases go red.
 */

import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config-store.ts";
import { isEnabled } from "./enable-check.ts";

const ENV_ON = { CLAUDE_MULTIACCT_ENABLE_SHIM: "1" };
const ENV_OFF: Record<string, string | undefined> = {};

describe("isEnabled", () => {
	it("env only → true", () => {
		expect(isEnabled({ env: ENV_ON, config: undefined })).toBe(true);
	});

	it("config only (enabled:true) → true", () => {
		expect(isEnabled({ env: ENV_OFF, config: { ...defaultConfig(), enabled: true } })).toBe(true);
	});

	it("both signals → true", () => {
		expect(isEnabled({ env: ENV_ON, config: { ...defaultConfig(), enabled: true } })).toBe(true);
	});

	it("neither signal → false", () => {
		expect(isEnabled({ env: ENV_OFF, config: undefined })).toBe(false);
		expect(isEnabled({ env: ENV_OFF, config: defaultConfig() })).toBe(false);
	});

	it("env value other than '1' → does not turn on by itself", () => {
		expect(isEnabled({ env: { CLAUDE_MULTIACCT_ENABLE_SHIM: "true" }, config: undefined })).toBe(
			false,
		);
		expect(isEnabled({ env: { CLAUDE_MULTIACCT_ENABLE_SHIM: "" }, config: undefined })).toBe(false);
	});
});
