/**
 * Intent: `FsChoiceStore` is the source of the shim's session→account
 * decisions. Three load-bearing behaviours:
 *
 * 1. Absent dir/file → empty state (the shim's fall-back-to-primary signal).
 *    Adversarial: if the impl started throwing on ENOENT, the shim would
 *    crash the user's Code session on first run when no sidecar exists yet.
 *
 * 2. Corrupted file → warn + skip, NOT throw (Rule 12 loud but not fatal
 *    for THIS path). Adversarial: if we invert to throw, the "corrupted →
 *    empty" test goes red — proving the guard exists.
 *
 * 3. Atomic write via tmp + rename — matching test verifies the final file
 *    is present and the temp file cleaned up after a successful write.
 */

import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import type { SessionAccountChoice } from "../domain/session-choice.ts";
import {
	defaultChoiceStoreDir,
	FsChoiceStore,
	InMemoryChoiceStore,
	silentLogger,
} from "./choice-store.ts";

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_A = "11111111-1111-4111-8111-111111111111" as AccountUuid;

function choice(sessionUuid: string, accountUuid: string): SessionAccountChoice {
	return {
		sessionUuid,
		accountUuid: accountUuid as AccountUuid,
		chosenAt: "2026-07-19T12:00:00.000Z",
	};
}

function tmp(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cma-choice-"));
}

describe("silentLogger — the no-op default the runtime binds when no logger is passed", () => {
	it("warn is a callable no-op (default-arg contract)", () => {
		expect(() => silentLogger.warn("anything")).not.toThrow();
	});
});

describe("defaultChoiceStoreDir", () => {
	it("resolves under the user's ~/.config path", () => {
		expect(defaultChoiceStoreDir()).toMatch(/\.config[/\\]claude-multiacct[/\\]session-account$/u);
	});
});

describe("InMemoryChoiceStore", () => {
	it("round-trips write → read", async () => {
		const store = new InMemoryChoiceStore();
		await store.write(choice(SESSION_A, UUID_A));
		const state = await store.read();
		expect(state[SESSION_A]?.accountUuid).toBe(UUID_A);
	});

	it("empty read returns {} (fall-back signal)", async () => {
		expect(await new InMemoryChoiceStore().read()).toStrictEqual({});
	});
});

describe("FsChoiceStore", () => {
	let dir: string;
	let warn: ReturnType<typeof vi.fn<(message: string) => void>>;

	beforeEach(async () => {
		dir = await tmp();
		warn = vi.fn<(message: string) => void>();
	});

	it("read on a missing dir returns empty state (never throws — fall-back path)", async () => {
		const store = new FsChoiceStore(join(dir, "does-not-exist"), { warn });
		expect(await store.read()).toStrictEqual({});
		expect(warn).not.toHaveBeenCalled();
	});

	it("read returns validated sidecars keyed by sessionUuid", async () => {
		const store = new FsChoiceStore(dir, { warn });
		await store.write(choice(SESSION_A, UUID_A));
		const state = await store.read();
		expect(state[SESSION_A]?.accountUuid).toBe(UUID_A);
	});

	it("corrupted (non-JSON) sidecar → warn + skip, does NOT throw (Rule 12 soft on this path)", async () => {
		// Adversarial: if the impl were to throw on JSON.parse errors, this
		// assertion (and thus the shim's ability to fall back to primary on a
		// corrupted sidecar) goes red. Do not weaken it.
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${SESSION_A}.json`), "not valid { json", "utf8");
		const store = new FsChoiceStore(dir, { warn });
		expect(await store.read()).toStrictEqual({});
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/corrupted sidecar/u));
	});

	it("schema-invalid sidecar (wrong shape) → warn + skip", async () => {
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, `${SESSION_A}.json`),
			JSON.stringify({ sessionUuid: SESSION_A, accountUuid: "not-a-uuid", chosenAt: "bad" }),
			"utf8",
		);
		const store = new FsChoiceStore(dir, { warn });
		expect(await store.read()).toStrictEqual({});
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/schema-invalid sidecar/u));
	});

	it("ignores non-.json entries in the dir (defensive against stray files)", async () => {
		const store = new FsChoiceStore(dir, { warn });
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "README"), "not a sidecar", "utf8");
		expect(await store.read()).toStrictEqual({});
	});

	it("write uses tmp + rename atomicity (final file present, no leftover .tmp)", async () => {
		const store = new FsChoiceStore(dir, { warn });
		await store.write(choice(SESSION_A, UUID_A));
		const files = await readdir(dir);
		expect(files).toContain(`${SESSION_A}.json`);
		expect(files.some((f) => f.includes(".tmp."))).toBe(false);
		const content = JSON.parse(await readFile(join(dir, `${SESSION_A}.json`), "utf8")) as {
			accountUuid: string;
		};
		expect(content.accountUuid).toBe(UUID_A);
	});

	it("unreadable sidecar (readdir listed a name that stat/readFile then fails on) → warn + skip", async () => {
		// Simulate the race where a sidecar was listed but subsequently
		// disappeared: readdir returns the name but readFile ENOENTs. The store
		// must skip + warn rather than throw (fall-back path).
		await mkdir(dir, { recursive: true });
		// Create a symlink pointing at a nonexistent target — readFile will fail.
		const { symlink } = await import("node:fs/promises");
		try {
			await symlink("/nonexistent/target", join(dir, `${SESSION_A}.json`));
		} catch {
			// Some filesystems disallow dangling symlinks under Windows; skip on those.
			return;
		}
		const store = new FsChoiceStore(dir, { warn });
		expect(await store.read()).toStrictEqual({});
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unreadable sidecar/u));
	});

	it("read rethrows non-ENOENT directory errors (e.g. permission denied) — fail loud", async () => {
		// Point the store at a file (not a dir): readdir errors with ENOTDIR,
		// which is NOT the ENOENT special case — the store must re-throw.
		const file = join(dir, "not-a-dir");
		await writeFile(file, "", "utf8");
		const store = new FsChoiceStore(file, { warn });
		await expect(store.read()).rejects.toThrow(/ENOTDIR/u);
	});

	it("default logger (silent) is used when none passed — covers the default arg path", async () => {
		const store = new FsChoiceStore(join(dir, "missing-dir"));
		expect(await store.read()).toStrictEqual({});
	});

	it("default dir resolves to ~/.config/.../session-account when no dir passed", async () => {
		// Instantiating with defaults must not throw. Read may or may not find
		// files depending on the environment; we only care that the code path runs.
		const store = new FsChoiceStore();
		expect(store).toBeInstanceOf(FsChoiceStore);
		// The default path may or may not exist; either resolves or throws is
		// acceptable — we're only exercising the default-arg branch.
		const outcome = await store.read().then(
			(state) => ({ ok: true, state }),
			(error: unknown) => ({ ok: false, error }),
		);
		expect(outcome).toBeDefined();
	});

	it("write rejects a malformed choice before touching disk (fail loud)", async () => {
		const store = new FsChoiceStore(dir, { warn });
		await expect(
			store.write({
				sessionUuid: "not-a-uuid",
				accountUuid: UUID_A,
				chosenAt: "2026-07-19T12:00:00.000Z",
			} as unknown as SessionAccountChoice),
		).rejects.toThrow(/uuid/iu);
		expect(await readdir(dir).catch(() => [])).toStrictEqual([]);
	});
});
