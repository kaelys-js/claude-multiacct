/**
 * Intent: `bridge.json` carries a bearer secret. Three failure modes each
 * corrupt a distinct invariant, so each has its own tripwire:
 *
 *  - `mode` is honored on both create AND overwrite. Adversarial: drop
 *    the explicit `chmod` between writeFile and rename → the overwrite
 *    case would still show the OLD mode on platforms where writeFile
 *    only honors mode on create.
 *  - Rename is called AFTER a tmp exists on disk (proves the write is
 *    tmp-first, so a crash between the two leaves the target
 *    untouched). We inject a fake `rename` that throws AFTER we've
 *    confirmed the tmp is on the real fs.
 *  - `mkdir -p` runs first so the caller can point at a not-yet-existing
 *    dir (bridge.json lives under `~/.config/claude-multiacct/`).
 */

import * as realFsp from "node:fs/promises";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AtomicWriteFs, atomicWriteJson } from "./atomic-json.ts";

async function scratch(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "cma-atomicjson-"));
}

describe("atomicWriteJson", () => {
	it("creates the target dir if missing and writes JSON", async () => {
		const root = await scratch();
		const path = join(root, "nested", "sub", "bridge.json");
		await atomicWriteJson(path, { hello: "world" }, 0o600);
		const raw = await readFile(path, "utf8");
		expect(JSON.parse(raw)).toEqual({ hello: "world" });
	});

	it("sets the requested owner-only mode (0o600) on create", async () => {
		const root = await scratch();
		const path = join(root, "bridge.json");
		await atomicWriteJson(path, { a: 1 }, 0o600);
		const st = await stat(path);
		// eslint-disable-next-line no-bitwise -- extracting POSIX mode bits requires bitmask
		const mode = st.mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("preserves the requested mode on overwrite (drop the explicit chmod → RED on platforms where writeFile mode is create-only)", async () => {
		const root = await scratch();
		const path = join(root, "bridge.json");
		// Seed a world-readable predecessor to make the failure mode observable.
		await writeFile(path, "{}", { encoding: "utf8", mode: 0o644 });
		await chmod(path, 0o644);
		await atomicWriteJson(path, { a: 2 }, 0o600);
		const st = await stat(path);
		// eslint-disable-next-line no-bitwise -- extracting POSIX mode bits requires bitmask
		const mode = st.mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("writes tmp first, then rename: injected rename throw leaves tmp on disk and target untouched", async () => {
		const root = await scratch();
		const path = join(root, "bridge.json");
		await atomicWriteJson(path, { previous: true }, 0o600);
		const before = await readFile(path, "utf8");

		const failingRename = vi.fn<() => Promise<void>>(() => {
			throw new Error("crash");
		});
		const deps: AtomicWriteFs = {
			mkdir: (p, o) => realFsp.mkdir(p, o),
			writeFile: (p, d, o) => realFsp.writeFile(p, d, o),
			chmod: (p, m) => realFsp.chmod(p, m),
			rename: failingRename,
		};
		await expect(atomicWriteJson(path, { new: true }, 0o600, deps)).rejects.toThrow("crash");

		const after = await readFile(path, "utf8");
		expect(after).toBe(before);
		// A tmp sidecar must be sitting there — proves the tmp-first invariant.
		const entries = await readdir(root);
		expect(entries.some((e) => e.startsWith("bridge.json.tmp-"))).toBe(true);
		expect(failingRename).toHaveBeenCalledTimes(1);
	});
});
