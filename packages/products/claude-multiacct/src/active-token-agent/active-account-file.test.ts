/**
 * Intent: this file is the companion → daemon channel, and its load-bearing
 * property is that reads FAIL CLOSED. Every malformed input the daemon might
 * encounter — file absent, non-JSON, a JSON non-object, a `null`/blank/missing
 * `activeUuid` — must resolve to `undefined` so the daemon falls back to its
 * first-account default rather than surfacing a stale or garbage guess. Each
 * branch below is a distinct way the file could be untrustworthy; drop any
 * guard and one of these trips.
 *
 * The write side is pinned through the injected `AtomicWriteFs` so we can assert
 * it goes through the tmp+rename atomic path at mode 0o600 (owner-only) without
 * touching the real disk.
 */

import { describe, expect, it, vi } from "vitest";
import type { AtomicWriteFs } from "../http-bridge/atomic-json.ts";
import {
	ACTIVE_ACCOUNT_FILENAME,
	type ActiveAccountRecord,
	defaultActiveAccountPath,
	type ReadActiveAccountFs,
	readActiveUuid,
	writeActiveAccount,
} from "./active-account-file.ts";

const PATH = "/home/u/.claude-multiacct/active-account.json";

function readerReturning(raw: string | Error): ReadActiveAccountFs {
	return {
		readFile: () => (raw instanceof Error ? Promise.reject(raw) : Promise.resolve(raw)),
	};
}

describe("defaultActiveAccountPath / ACTIVE_ACCOUNT_FILENAME", () => {
	it("resolves under ~/.claude-multiacct to the documented basename", () => {
		expect(ACTIVE_ACCOUNT_FILENAME).toBe("active-account.json");
		expect(defaultActiveAccountPath()).toMatch(/\.claude-multiacct\/active-account\.json$/u);
	});
});

describe("readActiveUuid — fail-closed on every untrustworthy input", () => {
	it("missing file (readFile rejects) → undefined", async () => {
		expect(await readActiveUuid(PATH, readerReturning(new Error("ENOENT")))).toBeUndefined();
	});

	it("non-JSON contents → undefined", async () => {
		expect(await readActiveUuid(PATH, readerReturning("}{not json"))).toBeUndefined();
	});

	it("JSON that is not an object (array) → undefined", async () => {
		expect(await readActiveUuid(PATH, readerReturning("[1,2,3]"))).toBeUndefined();
	});

	it("JSON null → undefined", async () => {
		expect(await readActiveUuid(PATH, readerReturning("null"))).toBeUndefined();
	});

	it("object with activeUuid=null (companion's 'no confident match') → undefined", async () => {
		const raw = JSON.stringify({ activeUuid: null, activeTokenSha: null, computedAt: "t" });
		expect(await readActiveUuid(PATH, readerReturning(raw))).toBeUndefined();
	});

	it("object with a blank activeUuid → undefined", async () => {
		expect(await readActiveUuid(PATH, readerReturning('{"activeUuid":""}'))).toBeUndefined();
	});

	it("object with a non-string activeUuid → undefined", async () => {
		expect(await readActiveUuid(PATH, readerReturning('{"activeUuid":123}'))).toBeUndefined();
	});

	it("object missing activeUuid entirely → undefined", async () => {
		expect(await readActiveUuid(PATH, readerReturning('{"other":1}'))).toBeUndefined();
	});

	it("a valid record → the uuid string", async () => {
		const raw = JSON.stringify({
			activeUuid: "9d1c250a",
			activeTokenSha: "346f747b",
			computedAt: "2026-07-22T00:00:00.000Z",
		});
		expect(await readActiveUuid(PATH, readerReturning(raw))).toBe("9d1c250a");
	});
});

type WriteCall = [string, string, { encoding: "utf8"; mode: number }];
type ChmodCall = [string, number];
type RenameCall = [string, string];

function makeAtomicFs(): {
	writes: WriteCall[];
	chmods: ChmodCall[];
	renames: RenameCall[];
	fs: AtomicWriteFs;
} {
	const writes: WriteCall[] = [];
	const chmods: ChmodCall[] = [];
	const renames: RenameCall[] = [];
	const fs: AtomicWriteFs = {
		mkdir: vi.fn<AtomicWriteFs["mkdir"]>(() => Promise.resolve(undefined)),
		writeFile: vi.fn<AtomicWriteFs["writeFile"]>((p, d, o) => {
			writes.push([p, d, o]);
			return Promise.resolve();
		}),
		chmod: vi.fn<AtomicWriteFs["chmod"]>((p, m) => {
			chmods.push([p, m]);
			return Promise.resolve();
		}),
		rename: vi.fn<AtomicWriteFs["rename"]>((f, t) => {
			renames.push([f, t]);
			return Promise.resolve();
		}),
	};
	return { writes, chmods, renames, fs };
}

describe("writeActiveAccount — atomic, owner-only publish", () => {
	it("writes the record JSON through tmp+rename at mode 0o600", async () => {
		const { writes, chmods, renames, fs } = makeAtomicFs();
		const record: ActiveAccountRecord = {
			activeUuid: "9d1c250a",
			activeTokenSha: "346f747b",
			computedAt: "2026-07-22T00:00:00.000Z",
		};
		await writeActiveAccount(PATH, record, fs);

		// tmp file written with the record body and 0o600, then chmod 0o600, then
		// renamed onto the final path.
		expect(writes).toHaveLength(1);
		const [tmpPath, body, opts] = writes[0] as WriteCall;
		expect(tmpPath.startsWith(`${PATH}.tmp-`)).toBe(true);
		expect(JSON.parse(body)).toStrictEqual(record);
		expect(opts.mode).toBe(0o600);
		expect(chmods[0]).toStrictEqual([tmpPath, 0o600]);
		expect(renames[0]).toStrictEqual([tmpPath, PATH]);
	});
});
