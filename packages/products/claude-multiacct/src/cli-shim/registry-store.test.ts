/**
 * Intent: `readRegistry` is the shim's gateway to the pool. Two negatives
 * are load-bearing for the shim's pass-through-to-primary fallback:
 * (1) missing file → undefined (no pool configured yet), (2) schema-invalid
 * file → undefined + warning (a rotted registry must not crash the user's
 * Code session). The positive case pins that a valid registry round-trips
 * through the schema unchanged.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultRegistryPath, readRegistry, silentLogger } from "./registry-store.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function tmp(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cma-registry-"));
}

const validRegistry = {
	accounts: [
		{
			uuid: UUID_A,
			label: "Personal",
			isPrimary: true,
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			encryptedTokenRef: "keychain:handle-a",
		},
		{
			uuid: UUID_B,
			label: "Work",
			isPrimary: false,
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			encryptedTokenRef: "keychain:handle-b",
		},
	],
};

describe("silentLogger — the no-op default the runtime binds when no logger is passed", () => {
	it("warn is a callable no-op (proves the default-arg is actually a function, not a stub)", () => {
		expect(() => silentLogger.warn("anything")).not.toThrow();
	});
});

describe("defaultRegistryPath", () => {
	it("resolves under ~/.config/claude-multiacct/registry.json", () => {
		expect(defaultRegistryPath()).toMatch(/\.config[/\\]claude-multiacct[/\\]registry\.json$/u);
	});
});

describe("readRegistry", () => {
	it("returns undefined when the file is missing (no pool configured yet)", async () => {
		const dir = await tmp();
		const warn = vi.fn<(message: string) => void>();
		expect(await readRegistry(join(dir, "missing.json"), { warn })).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns the parsed registry when the file is valid", async () => {
		const dir = await tmp();
		const p = join(dir, "registry.json");
		await writeFile(p, JSON.stringify(validRegistry), "utf8");
		const warn = vi.fn<(message: string) => void>();
		const reg = await readRegistry(p, { warn });
		expect(reg?.accounts).toHaveLength(2);
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns undefined + warns on corrupted JSON (fail-safe on this path)", async () => {
		const dir = await tmp();
		const p = join(dir, "registry.json");
		await writeFile(p, "{ not json", "utf8");
		const warn = vi.fn<(message: string) => void>();
		expect(await readRegistry(p, { warn })).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/corrupted registry/u));
	});

	it("returns undefined + warns when the path is a directory (non-ENOENT read error)", async () => {
		// Pointing at a directory triggers EISDIR on readFile — a non-ENOENT
		// failure that must still fall back to undefined so the shim can
		// pass through to primary instead of crashing.
		const dir = await tmp();
		const warn = vi.fn<(message: string) => void>();
		expect(await readRegistry(dir, { warn })).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unreadable registry/u));
	});

	it("uses default logger (silent) when none is passed — covers the default arg path", async () => {
		const dir = await tmp();
		// Missing → undefined, no throw, silent.
		expect(await readRegistry(join(dir, "missing.json"))).toBeUndefined();
	});

	it("uses defaultRegistryPath when no path is passed (does not crash on real home)", async () => {
		// Call with zero args — the fallback resolves to ~/.config/.../registry.json.
		// Either the file exists (unlikely under CI's tmp HOME) or it doesn't;
		// either way this must not throw.
		const outcome = await readRegistry().then(
			(reg) => ({ ok: true as const, reg }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		expect(outcome).toBeDefined();
	});

	it("returns undefined + warns on schema-invalid registry (invariant violation, not runtime crash)", async () => {
		const dir = await tmp();
		const p = join(dir, "registry.json");
		// Two primaries — inverts the exactly-one-primary invariant from PR1's
		// AccountRegistrySchema. If the shim treated this as fatal, one bad
		// hand-edit would brick the desktop launcher; the fail-safe design
		// falls back to primary-passthrough instead.
		const twoPrimary = {
			accounts: [
				{ ...validRegistry.accounts[0], isPrimary: true },
				{ ...validRegistry.accounts[1], isPrimary: true },
			],
		};
		await writeFile(p, JSON.stringify(twoPrimary), "utf8");
		const warn = vi.fn<(message: string) => void>();
		expect(await readRegistry(p, { warn })).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/schema-invalid registry/u));
	});
});
