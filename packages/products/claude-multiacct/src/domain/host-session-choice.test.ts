/**
 * Intent: `HostSessionChoice` is the restart-surviving binding — the model the
 * shim keys on so a chosen account is re-applied after Claude.app restarts. Two
 * load-bearing behaviours:
 *
 * 1. The host session id must be a bounded, filename-safe token. It becomes a
 *    path segment in the sidecar store, so accepting `../` or an unbounded
 *    string would be a path-traversal / oversized-filename hazard. Adversarial:
 *    loosen the regex and the traversal-rejection test goes red.
 *
 * 2. `strictObject` — an unknown or misspelled field fails validation rather
 *    than silently resolving to an undefined account uuid.
 */

import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { HostSessionChoiceSchema, isValidHostSessionId } from "./host-session-choice.ts";

const ACCOUNT = "22222222-2222-4222-8222-222222222222";

describe("isValidHostSessionId", () => {
	it("accepts the app's local_<uuid> shape and other filename-safe tokens", () => {
		expect(isValidHostSessionId("local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
		expect(isValidHostSessionId("A_b-9")).toBe(true);
	});

	it("rejects empty, path-traversing, and separator-bearing ids", () => {
		// These are exactly the values that must never become a filename.
		expect(isValidHostSessionId("")).toBe(false);
		expect(isValidHostSessionId("../etc/passwd")).toBe(false);
		expect(isValidHostSessionId("has/slash")).toBe(false);
		expect(isValidHostSessionId("has.dot")).toBe(false);
		expect(isValidHostSessionId("spa ce")).toBe(false);
	});

	it("rejects an over-long id (the length ceiling guards the filename)", () => {
		expect(isValidHostSessionId("a".repeat(129))).toBe(false);
		expect(isValidHostSessionId("a".repeat(128))).toBe(true);
	});
});

describe("HostSessionChoiceSchema", () => {
	it("parses a well-formed choice", () => {
		const parsed = v.parse(HostSessionChoiceSchema, {
			hostSessionId: "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			accountUuid: ACCOUNT,
			chosenAt: "2026-07-24T00:00:00.000Z",
		});
		expect(parsed.accountUuid).toBe(ACCOUNT);
	});

	it("rejects a malformed host session id", () => {
		expect(
			v.safeParse(HostSessionChoiceSchema, {
				hostSessionId: "../nope",
				accountUuid: ACCOUNT,
				chosenAt: "2026-07-24T00:00:00.000Z",
			}).success,
		).toBe(false);
	});

	it("rejects an unknown extra field (strictObject)", () => {
		expect(
			v.safeParse(HostSessionChoiceSchema, {
				hostSessionId: "local_x",
				accountUuid: ACCOUNT,
				chosenAt: "2026-07-24T00:00:00.000Z",
				extra: "nope",
			}).success,
		).toBe(false);
	});

	it("rejects a non-ISO timestamp", () => {
		expect(
			v.safeParse(HostSessionChoiceSchema, {
				hostSessionId: "local_x",
				accountUuid: ACCOUNT,
				chosenAt: "yesterday",
			}).success,
		).toBe(false);
	});
});
