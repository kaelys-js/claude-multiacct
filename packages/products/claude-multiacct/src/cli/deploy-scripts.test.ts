/* oxlint-disable eslint/require-await, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, typescript/explicit-function-return-type, eslint/curly, vitest/no-conditional-in-test */
/**
 * Intent: PR6b's install step needs the files launchd points at (`~/.claude-
 * multiacct/watcher.js`, `.../daemon.js`) to ACTUALLY EXIST before the plists
 * load. Without deployment, launchd's `execve` on the ProgramArguments would
 * ENOENT on every wake — the whole watcher/daemon pair silently dead.
 *
 * These tests pin the deploy contract:
 *   - target gets created as a symlink pointing at the given source
 *   - pre-existing file at the target is snapshotted (byte-for-byte) BEFORE
 *     being removed (adversarial: skip snapshot → red)
 *   - a re-run with the same source is a no-op (idempotent)
 *   - undeploy only removes symlinks (never files it doesn't own)
 */

import { describe, expect, it } from "vitest";
import {
	type DeployFs,
	deployAgentScripts,
	type DeployPair,
	undeployAgentScripts,
} from "./deploy-scripts.ts";

type FakeStat = { isSymbolicLink: () => boolean; isFile: () => boolean };

type State = {
	symlinks: Map<string, string>;
	files: Map<string, Buffer>;
	dirs: Set<string>;
	ops: string[];
};

function newState(): State {
	return { symlinks: new Map(), files: new Map(), dirs: new Set(), ops: [] };
}

function makeFs(s: State): DeployFs {
	return {
		mkdir: async (p) => {
			s.ops.push(`mkdir:${p}`);
			s.dirs.add(p);
		},
		lstat: async (p) => {
			if (s.symlinks.has(p)) {
				return { isSymbolicLink: () => true, isFile: () => false } as FakeStat;
			}
			if (s.files.has(p)) {
				return { isSymbolicLink: () => false, isFile: () => true } as FakeStat;
			}
			throw new Error(`ENOENT ${p}`);
		},
		readlink: async (p) => s.symlinks.get(p) ?? "",
		symlink: async (target, path) => {
			s.ops.push(`symlink:${path}→${target}`);
			s.symlinks.set(path, target);
		},
		rm: async (p) => {
			s.ops.push(`rm:${p}`);
			s.symlinks.delete(p);
			s.files.delete(p);
		},
		copyFile: async (src, dest) => {
			s.ops.push(`copyFile:${src}→${dest}`);
			const bytes = s.files.get(src);
			if (bytes === undefined) throw new Error(`ENOENT ${src}`);
			s.files.set(dest, bytes);
		},
	};
}

const pair: DeployPair = {
	name: "watcher.js",
	target: "/home/.claude-multiacct/watcher.js",
	source: "/opt/pkg/dist/watcher.js",
};

const opts = {
	backupsRoot: "/home/.claude-multiacct-backups",
	now: () => new Date("2026-07-20T00:00:00.000Z"),
};

describe("deployAgentScripts — target created as symlink → source", () => {
	it("no pre-existing target: mkdir parent, symlink into place", async () => {
		const s = newState();
		const r = await deployAgentScripts(makeFs(s), [pair], opts);
		expect(r.deployed).toHaveLength(1);
		expect(s.symlinks.get(pair.target)).toBe(pair.source);
		expect(s.ops.some((o) => o.startsWith("mkdir:"))).toBe(true);
	});

	it("Bug 3 adversarial: file the plist references EXISTS after deploy (skip the deploy step → this test goes red)", async () => {
		const s = newState();
		await deployAgentScripts(makeFs(s), [pair], opts);
		// The file the launchd ProgramArguments points at must resolve.
		expect(s.symlinks.has(pair.target) || s.files.has(pair.target)).toBe(true);
	});

	it("idempotent: second run with same source → no snapshot, no re-link", async () => {
		const s = newState();
		await deployAgentScripts(makeFs(s), [pair], opts);
		const opsAfterFirst = s.ops.length;
		await deployAgentScripts(makeFs(s), [pair], opts);
		// Second run touches nothing after the initial lstat.
		expect(s.ops.length).toBe(opsAfterFirst);
	});

	it("pre-existing FILE at target: snapshot (copyFile) BEFORE rm, then symlink (adversarial: drop snapshot → red)", async () => {
		const s = newState();
		s.files.set(pair.target, Buffer.from("legacy user script"));
		await deployAgentScripts(makeFs(s), [pair], opts);
		const copyIdx = s.ops.findIndex((o) => o.startsWith("copyFile:"));
		const rmIdx = s.ops.findIndex((o) => o.startsWith(`rm:${pair.target}`));
		const linkIdx = s.ops.findIndex((o) => o.startsWith("symlink:"));
		expect(copyIdx).toBeGreaterThanOrEqual(0);
		expect(rmIdx).toBeGreaterThan(copyIdx);
		expect(linkIdx).toBeGreaterThan(rmIdx);
	});

	it("pre-existing WRONG-source symlink: replaced with correct source", async () => {
		const s = newState();
		s.symlinks.set(pair.target, "/opt/old/watcher.js");
		await deployAgentScripts(makeFs(s), [pair], opts);
		expect(s.symlinks.get(pair.target)).toBe(pair.source);
	});
});

describe("undeployAgentScripts — only removes symlinks", () => {
	it("symlink present → removed", async () => {
		const s = newState();
		s.symlinks.set(pair.target, pair.source);
		await undeployAgentScripts(makeFs(s), [pair]);
		expect(s.symlinks.has(pair.target)).toBe(false);
	});

	it("file present (not our symlink) → left in place", async () => {
		const s = newState();
		s.files.set(pair.target, Buffer.from("user"));
		await undeployAgentScripts(makeFs(s), [pair]);
		expect(s.files.has(pair.target)).toBe(true);
	});

	it("missing → no-op", async () => {
		const s = newState();
		await undeployAgentScripts(makeFs(s), [pair]);
		expect(s.ops).toStrictEqual([]);
	});
});
