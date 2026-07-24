/**
 * Intent: `FsHostChoiceStore` persists the restart-surviving host→account
 * binding. Load-bearing behaviours:
 *
 * 1. Round-trips a write → read by the same host session id.
 * 2. Missing sidecar → `undefined` (the shim's fall-back-to-primary signal),
 *    never a throw — a first-run conversation has no sidecar yet.
 * 3. Corrupt / schema-invalid / id-mismatched sidecar → warn + `undefined`,
 *    NOT a throw (same soft-failure posture as `FsChoiceStore`). Adversarial:
 *    invert any guard to throw and the matching "→ undefined" test goes red.
 * 4. An invalid host session id never becomes a path (traversal guard): read
 *    returns `undefined` without touching disk, write throws.
 * 5. Atomic write via tmp + rename leaves only the final file.
 */

import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import type { HostSessionChoice } from "../domain/host-session-choice.ts";
import {
	defaultHostChoiceStoreDir,
	FsHostChoiceStore,
	InMemoryHostChoiceStore,
} from "./host-choice-store.ts";

const HOST_ID = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_A = "11111111-1111-4111-8111-111111111111" as AccountUuid;

function choice(hostSessionId: string, accountUuid: string): HostSessionChoice {
	return {
		hostSessionId,
		accountUuid: accountUuid as AccountUuid,
		chosenAt: "2026-07-24T12:00:00.000Z",
	};
}

function tmp(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cma-host-choice-"));
}

describe("defaultHostChoiceStoreDir", () => {
	it("resolves under the user's ~/.config path", () => {
		expect(defaultHostChoiceStoreDir()).toMatch(
			/\.config[/\\]claude-multiacct[/\\]host-session-account$/u,
		);
	});
});

describe("InMemoryHostChoiceStore", () => {
	it("round-trips write → read; unknown id → undefined", async () => {
		const store = new InMemoryHostChoiceStore();
		await store.write(choice(HOST_ID, UUID_A));
		expect(await store.read(HOST_ID)).toStrictEqual(choice(HOST_ID, UUID_A));
		expect(await store.read("local_unknown")).toBeUndefined();
	});
});

describe("FsHostChoiceStore", () => {
	it("round-trips a write → read by host session id, atomically (only the final file remains)", async () => {
		const dir = await tmp();
		const store = new FsHostChoiceStore(dir);
		await store.write(choice(HOST_ID, UUID_A));
		expect(await store.read(HOST_ID)).toStrictEqual(choice(HOST_ID, UUID_A));
		// No leftover tmp file from the atomic tmp+rename.
		const entries = await readdir(dir);
		expect(entries).toStrictEqual([`${HOST_ID}.json`]);
	});

	it("missing sidecar → undefined (fall back to primary, never throw)", async () => {
		const store = new FsHostChoiceStore(await tmp());
		expect(await store.read(HOST_ID)).toBeUndefined();
	});

	it("corrupt (non-JSON) sidecar → warn + undefined", async () => {
		const dir = await tmp();
		await writeFile(join(dir, `${HOST_ID}.json`), "{not json", "utf8");
		const warn = vi.fn<(m: string) => void>();
		const store = new FsHostChoiceStore(dir, { warn });
		expect(await store.read(HOST_ID)).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupted sidecar"));
	});

	it("schema-invalid sidecar → warn + undefined", async () => {
		const dir = await tmp();
		await writeFile(
			join(dir, `${HOST_ID}.json`),
			JSON.stringify({ hostSessionId: HOST_ID, accountUuid: "not-a-uuid", chosenAt: "x" }),
			"utf8",
		);
		const warn = vi.fn<(m: string) => void>();
		const store = new FsHostChoiceStore(dir, { warn });
		expect(await store.read(HOST_ID)).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("schema-invalid sidecar"));
	});

	it("sidecar whose stored id mismatches the filename → warn + undefined (defensive)", async () => {
		const dir = await tmp();
		// File named for HOST_ID but storing a DIFFERENT valid host id inside.
		await writeFile(
			join(dir, `${HOST_ID}.json`),
			JSON.stringify(choice("local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", UUID_A)),
			"utf8",
		);
		const warn = vi.fn<(m: string) => void>();
		const store = new FsHostChoiceStore(dir, { warn });
		expect(await store.read(HOST_ID)).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("mismatched hostSessionId"));
	});

	it("invalid host session id → read returns undefined without touching disk", async () => {
		// A traversal id must never build a path. Point the store at a dir that
		// does not exist; a correct guard returns before any fs access.
		const store = new FsHostChoiceStore(join(await tmp(), "does-not-exist"));
		expect(await store.read("../etc/passwd")).toBeUndefined();
	});

	it("write rejects an invalid host session id (never persists a traversal filename)", async () => {
		const store = new FsHostChoiceStore(await tmp());
		await expect(store.write(choice("../evil", UUID_A))).rejects.toThrow(/host session id/u);
	});

	it("write is durable across a fresh store instance (same dir)", async () => {
		const dir = await tmp();
		await new FsHostChoiceStore(dir).write(choice(HOST_ID, UUID_A));
		// A brand-new instance (models the post-restart shim process) reads it back.
		expect(await new FsHostChoiceStore(dir).read(HOST_ID)).toStrictEqual(choice(HOST_ID, UUID_A));
	});
});
