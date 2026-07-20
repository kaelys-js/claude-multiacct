/* oxlint-disable vitest/require-to-throw-message */
/**
 * Intent: pin the `MutableTokenStore` port contract — get returns undefined
 * on miss (soft), put+delete are idempotent, snapshot is a read-only view.
 * The rollback tests in `./provisioning.test.ts` depend on these semantics.
 */

import { describe, expect, it } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import { InMemoryMutableTokenStore } from "./token-store-mut.ts";

const UUID = "11111111-1111-4111-8111-111111111111" as AccountUuid;

describe("InMemoryMutableTokenStore", () => {
	it("get returns undefined for an unknown uuid (soft miss — matches port)", async () => {
		const store = new InMemoryMutableTokenStore();
		expect(await store.get(UUID)).toBeUndefined();
	});
	it("put + get round-trips the value", async () => {
		const store = new InMemoryMutableTokenStore();
		await store.put(UUID, "handle");
		expect(await store.get(UUID)).toBe("handle");
	});
	it("delete removes an existing entry", async () => {
		const store = new InMemoryMutableTokenStore();
		await store.put(UUID, "handle");
		await store.delete(UUID);
		expect(await store.get(UUID)).toBeUndefined();
	});
	it("delete on a missing uuid is a no-op (idempotent)", async () => {
		const store = new InMemoryMutableTokenStore();
		await store.delete(UUID);
		expect(await store.get(UUID)).toBeUndefined();
	});
	it("snapshot returns a plain read-only view", async () => {
		const store = new InMemoryMutableTokenStore();
		await store.put(UUID, "h");
		expect(store.snapshot()).toEqual({ [UUID]: "h" });
	});
});
