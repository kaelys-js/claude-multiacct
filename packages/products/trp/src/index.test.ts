import { describe, it, expect } from "vitest";
import { productName } from "./index.ts";

describe("@foundation/trp product shell (Phase 1)", () => {
	it("exports the product name so Vitest has a covered file", () => {
		expect(productName).toBe("@foundation/trp");
	});
});
