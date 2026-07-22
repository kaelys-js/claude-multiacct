/* oxlint-disable jsdoc/require-param, jsdoc/require-returns, vitest/no-conditional-in-test, unicorn/consistent-function-scoping */
/**
 * Intent: `fetchAccountProfile` turns an opaque `sk-ant-oat` token into the
 * account's real, server-side identity (the pool's dedup key + the human email).
 * The tests pin the authenticated request shape (bearer + the required beta
 * header), the success extraction (uuid / email / display name / subscription),
 * and each classified failure branch — a resolver that cannot distinguish a
 * revoked token (401) from a network drop would strand discovery on the wrong
 * recovery path.
 */

import { describe, expect, it } from "vitest";
import {
	fetchAccountProfile,
	OAUTH_BETA_HEADER,
	PROFILE_URL,
	type ProfileFetch,
} from "./identity.ts";

const ACCOUNT_UUID = "918f32f7-44c2-442e-8d5d-48ca3792ea95";

/** Build a fake fetch returning a fixed status + body, capturing the request. */
function fakeFetch(
	status: number,
	body: string,
	capture?: { url?: string; headers?: Record<string, string> },
): ProfileFetch {
	return (url, init) => {
		if (capture !== undefined) {
			capture.url = url;
			capture.headers = init.headers;
		}
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			text: () => Promise.resolve(body),
		});
	};
}

function profileBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		account: {
			uuid: ACCOUNT_UUID,
			email: "cole@icloud.com",
			display_name: "Cole",
			full_name: "Cole Bieker",
			has_claude_max: true,
			...overrides,
		},
		organization: { uuid: "b3bf40ff-0e9b-4a5d-b1c1-c701f1eff98a", name: "org" },
	});
}

describe("fetchAccountProfile — request shape", () => {
	it("GETs the profile URL with a bearer token and the OAuth beta header", async () => {
		const cap: { url?: string; headers?: Record<string, string> } = {};
		await fetchAccountProfile("sk-ant-oat01-XYZ", fakeFetch(200, profileBody(), cap));
		expect(cap.url).toBe(PROFILE_URL);
		expect(cap.headers?.Authorization).toBe("Bearer sk-ant-oat01-XYZ");
		expect(cap.headers?.["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
	});
});

describe("fetchAccountProfile — success extraction", () => {
	it("returns the real account uuid, email, display name, and a max subscription", async () => {
		const result = await fetchAccountProfile("t", fakeFetch(200, profileBody()));
		expect(result).toEqual({
			ok: true,
			profile: {
				accountUuid: ACCOUNT_UUID,
				email: "cole@icloud.com",
				displayName: "Cole",
				subscriptionType: "claude_max",
				rateLimitTier: "unknown",
			},
		});
	});

	it("falls back to full_name when display_name is absent", async () => {
		const body = profileBody({ display_name: undefined });
		const result = await fetchAccountProfile("t", fakeFetch(200, body));
		expect(result.ok && result.profile.displayName).toBe("Cole Bieker");
	});

	it("maps has_claude_pro to claude_pro when max is absent", async () => {
		const body = profileBody({ has_claude_max: false, has_claude_pro: true });
		const result = await fetchAccountProfile("t", fakeFetch(200, body));
		expect(result.ok && result.profile.subscriptionType).toBe("claude_pro");
	});

	it("maps no plan flags to unknown", async () => {
		const body = profileBody({ has_claude_max: false });
		const result = await fetchAccountProfile("t", fakeFetch(200, body));
		expect(result.ok && result.profile.subscriptionType).toBe("unknown");
	});

	it("treats a blank email as absent (never a real identity)", async () => {
		const body = profileBody({ email: "" });
		const result = await fetchAccountProfile("t", fakeFetch(200, body));
		expect(result.ok && result.profile.email).toBeUndefined();
	});
});

describe("fetchAccountProfile — classified failures", () => {
	it("401 → unauthorized (token revoked; re-auth, not retry)", async () => {
		const result = await fetchAccountProfile("t", fakeFetch(401, "no"));
		expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
	});

	it("403 → unauthorized", async () => {
		const result = await fetchAccountProfile("t", fakeFetch(403, "no"));
		expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
	});

	it("500 → unexpected", async () => {
		const result = await fetchAccountProfile("t", fakeFetch(500, "boom"));
		expect(result).toMatchObject({ ok: false, kind: "unexpected" });
	});

	it("2xx with non-JSON body → malformed", async () => {
		const result = await fetchAccountProfile("t", fakeFetch(200, "not json"));
		expect(result).toMatchObject({ ok: false, kind: "malformed" });
	});

	it("2xx JSON missing account.uuid → malformed", async () => {
		const result = await fetchAccountProfile("t", fakeFetch(200, JSON.stringify({ account: {} })));
		expect(result).toMatchObject({ ok: false, kind: "malformed" });
	});

	it("fetch rejecting → network", async () => {
		const throwing: ProfileFetch = () => Promise.reject(new Error("dns"));
		const result = await fetchAccountProfile("t", throwing);
		expect(result).toMatchObject({ ok: false, kind: "network" });
	});

	it("body read throwing → network", async () => {
		const badBody: ProfileFetch = () =>
			Promise.resolve({ ok: true, status: 200, text: () => Promise.reject(new Error("torn")) });
		const result = await fetchAccountProfile("t", badBody);
		expect(result).toMatchObject({ ok: false, kind: "network" });
	});
});
