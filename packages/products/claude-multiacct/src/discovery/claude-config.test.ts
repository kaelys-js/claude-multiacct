/* oxlint-disable jsdoc/require-param, jsdoc/require-returns */
/**
 * Intent: `readLastKnownAccountUuid` is the keychain-free active-account signal —
 * the plaintext marker Claude.app writes for the account it is signed into. It
 * must return the marker when present and fail closed (undefined) on every
 * degraded input, because the daemon acts on the result: a torn or invented
 * value would mis-highlight the picker.
 */

import { describe, expect, it } from "vitest";
import {
	defaultClaudeConfigJsonPath,
	LAST_KNOWN_ACCOUNT_UUID_KEY,
	readLastKnownAccountUuid,
} from "./claude-config.ts";

const PATH = "/fake/Claude/config.json";
const MARKER = "918f32f7-44c2-442e-8d5d-48ca3792ea95";

/** A read surface returning fixed content, or throwing to model a missing file. */
function fs(content: string | Error): { readFile: (p: string) => Promise<string> } {
	return {
		readFile: () => (content instanceof Error ? Promise.reject(content) : Promise.resolve(content)),
	};
}

describe("readLastKnownAccountUuid", () => {
	it("returns the plaintext marker when present", async () => {
		const raw = JSON.stringify({ [LAST_KNOWN_ACCOUNT_UUID_KEY]: MARKER, other: 1 });
		expect(await readLastKnownAccountUuid(PATH, fs(raw))).toBe(MARKER);
	});

	it("returns undefined when the file is missing (read throws)", async () => {
		expect(await readLastKnownAccountUuid(PATH, fs(new Error("ENOENT")))).toBeUndefined();
	});

	it("returns undefined when the content is not JSON", async () => {
		expect(await readLastKnownAccountUuid(PATH, fs("{not json"))).toBeUndefined();
	});

	it("returns undefined when the parsed value is not an object", async () => {
		expect(await readLastKnownAccountUuid(PATH, fs("42"))).toBeUndefined();
	});

	it("returns undefined when the marker key is absent", async () => {
		expect(
			await readLastKnownAccountUuid(PATH, fs(JSON.stringify({ locale: "en" }))),
		).toBeUndefined();
	});

	it("returns undefined when the marker is blank or non-string", async () => {
		expect(
			await readLastKnownAccountUuid(
				PATH,
				fs(JSON.stringify({ [LAST_KNOWN_ACCOUNT_UUID_KEY]: "" })),
			),
		).toBeUndefined();
		expect(
			await readLastKnownAccountUuid(
				PATH,
				fs(JSON.stringify({ [LAST_KNOWN_ACCOUNT_UUID_KEY]: 7 })),
			),
		).toBeUndefined();
	});

	it("defaultClaudeConfigJsonPath points at Claude's Application Support config.json", () => {
		expect(defaultClaudeConfigJsonPath()).toMatch(
			/Library\/Application Support\/Claude\/config\.json$/u,
		);
	});
});
