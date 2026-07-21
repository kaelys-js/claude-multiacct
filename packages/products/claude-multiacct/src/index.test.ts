import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./index.ts";

// Read the manifest that ships with the package, not a hardcoded copy. The point
// of these tests is that the exported identity and the published manifest cannot
// drift apart: rename the package or bump its version in one place and forget the
// other, and the suite fails. A test that hardcoded both sides would pass through
// exactly the mistake it is supposed to catch.
const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { name: string; version: string };

describe("@foundation/claude-multiacct package identity", () => {
	it("exports the name declared in package.json", () => {
		expect(PACKAGE_NAME).toBe(manifest.name);
		expect(PACKAGE_NAME).toBe("@foundation/claude-multiacct");
	});

	it("exports the version declared in package.json", () => {
		expect(PACKAGE_VERSION).toBe(manifest.version);
	});
});
