/**
 * Intent: the argv string handed to Chromium is load-bearing on the
 * escape from CWS pings. A drop or reorder here silently re-exposes the
 * extension update path.
 *
 *  - Golden-string assertion pins the exact rendered value.
 *  - Adversarial: drop one endpoint → the "renders both endpoints" test
 *    goes RED because Chromium would then resolve the dropped host
 *    normally.
 */

import { describe, expect, it } from "vitest";
import { CWS_ENDPOINTS, renderHostResolverRules } from "./host-resolver.ts";

describe("renderHostResolverRules", () => {
	it("golden: matches the exact Chromium value for the CWS endpoint list", () => {
		expect(renderHostResolverRules(CWS_ENDPOINTS)).toBe(
			"MAP clients2.google.com 0.0.0.0,MAP chrome.google.com 0.0.0.0",
		);
	});

	it("renders every provided endpoint (drop one → RED)", () => {
		const rendered = renderHostResolverRules(CWS_ENDPOINTS);
		for (const endpoint of CWS_ENDPOINTS) {
			expect(rendered).toContain(`MAP ${endpoint} 0.0.0.0`);
		}
	});

	it("empty input → empty string", () => {
		expect(renderHostResolverRules([])).toBe("");
	});

	it("single endpoint → no trailing comma", () => {
		expect(renderHostResolverRules(["a.example.com"])).toBe("MAP a.example.com 0.0.0.0");
	});
});
