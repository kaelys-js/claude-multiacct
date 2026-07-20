/**
 * Intent: `scan.ts` is what teaches the watcher what a "fresh unshimmed" dir
 * looks like versus one we've already handled. If classification drifts, the
 * watcher would either re-install over a good dir (unsafe) or refuse to
 * install over a fresh one (silent no-op — the exact regression PR3 exists
 * to prevent). These cases pin each branch of the classifier with a
 * hand-built fake fs, so a change to the shape (`.real` empty, missing
 * MacOS, pre-release version) surfaces here instead of at a user machine.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FsPort } from "./fs-port.ts";
import { scanClaudeCodeDirs } from "./scan.ts";

/**
 * Build a synchronous fs fake from a `{path → kind}` map.
 *
 * @param {Record<string,string>} entries - Map of absolute path → file kind.
 * @returns {FsPort} A stub FsPort backed by the entries.
 */
function fakeFs(entries: Record<string, "dir" | "file-empty" | "file-nonempty">): FsPort {
	return {
		readdirSync: (path) => {
			const prefix = `${path}/`;
			const names = new Set<string>();
			for (const p of Object.keys(entries)) {
				if (p.startsWith(prefix)) {
					const rest = p.slice(prefix.length);
					const [first] = rest.split("/", 1);
					if (first !== undefined && first !== "") {
						names.add(first);
					}
				}
			}
			return [...names];
		},
		statSync: (path) => {
			const kind = entries[path];
			if (kind === undefined) {
				throw new Error(`ENOENT ${path}`);
			}
			const isDir = kind === "dir";
			const size = kind === "file-nonempty" ? 42 : 0;
			return { isDirectory: () => isDir, size };
		},
		existsSync: (path) => Object.hasOwn(entries, path),
	};
}

const parent = "/tmp/claude-code";
const macosOf = (v: string): string => `${parent}/${v}/claude.app/Contents/MacOS`;

const readdirThrow = (): string[] => {
	throw new Error("EACCES");
};

const alwaysFalse = (): boolean => false;
const noopStat = (): { isDirectory: () => boolean; size: number } => ({
	isDirectory: alwaysFalse,
	size: 0,
});

/**
 * Fake stat that throws for exactly `failPath` and otherwise returns a
 * generic dir. Constructed at module scope so the branch inside doesn't
 * count as a conditional-in-test.
 *
 * @param {string} failPath - The path to fail on.
 * @returns {FsPort["statSync"]} Stat fn.
 */
function failOnStat(failPath: string): FsPort["statSync"] {
	return (p) => {
		if (p === failPath) {
			throw new Error("boom");
		}
		return { isDirectory: () => true, size: 1 };
	};
}

describe("scanClaudeCodeDirs", () => {
	it("empty parent → []", () => {
		expect(scanClaudeCodeDirs(parent, fakeFs({}))).toStrictEqual([]);
	});

	it("unreadable parent → [] (fail-safe, launchd has nowhere to route errors)", () => {
		const throwingFs: FsPort = {
			readdirSync: readdirThrow,
			statSync: noopStat,
			existsSync: () => false,
		};
		expect(scanClaudeCodeDirs(parent, throwingFs)).toStrictEqual([]);
	});

	it("single unshimmed version dir → kind=uninstalled", () => {
		const v = "1.2.3";
		const macos = macosOf(v);
		const fs = fakeFs({
			[`${parent}/${v}`]: "dir",
			[macos]: "dir",
			[`${macos}/claude`]: "file-nonempty",
		});
		expect(scanClaudeCodeDirs(parent, fs)).toStrictEqual([
			{ path: `${parent}/${v}`, version: v, kind: "uninstalled" },
		]);
	});

	it("single shimmed version dir (claude + non-empty claude.real) → kind=installed", () => {
		const v = "1.2.3";
		const macos = macosOf(v);
		const fs = fakeFs({
			[`${parent}/${v}`]: "dir",
			[macos]: "dir",
			[`${macos}/claude`]: "file-nonempty",
			[`${macos}/claude.real`]: "file-nonempty",
		});
		expect(scanClaudeCodeDirs(parent, fs)).toStrictEqual([
			{ path: `${parent}/${v}`, version: v, kind: "installed" },
		]);
	});

	it("empty claude.real → other 'empty-claude-real' (defensive; prevents overwriting a partial install)", () => {
		const v = "1.2.3";
		const macos = macosOf(v);
		const fs = fakeFs({
			[`${parent}/${v}`]: "dir",
			[macos]: "dir",
			[`${macos}/claude`]: "file-nonempty",
			[`${macos}/claude.real`]: "file-empty",
		});
		expect(scanClaudeCodeDirs(parent, fs)[0]).toStrictEqual({
			path: `${parent}/${v}`,
			version: v,
			kind: "other",
			reason: "empty-claude-real",
		});
	});

	it("mixed multi-version parent classifies each dir independently", () => {
		const v1 = "1.2.3";
		const v2 = "1.3.0";
		const v3 = "2.0.0-beta.1"; // pre-release still parses as version
		const fs = fakeFs({
			[`${parent}/${v1}`]: "dir",
			[macosOf(v1)]: "dir",
			[`${macosOf(v1)}/claude`]: "file-nonempty",
			[`${macosOf(v1)}/claude.real`]: "file-nonempty",
			[`${parent}/${v2}`]: "dir",
			[macosOf(v2)]: "dir",
			[`${macosOf(v2)}/claude`]: "file-nonempty",
			[`${parent}/${v3}`]: "dir",
			// v3 missing MacOS dir → other
		});
		const states = scanClaudeCodeDirs(parent, fs);
		const kinds = Object.fromEntries(states.map((s) => [s.version, s.kind]));
		expect(kinds).toStrictEqual({ [v1]: "installed", [v2]: "uninstalled", [v3]: "other" });
		const v3State = states.find((s) => s.version === v3);
		expect(v3State?.reason).toBe("missing-macos-dir");
	});

	it("non-version children (`.DS_Store`, `README`) are silently ignored", () => {
		const fs = fakeFs({
			[`${parent}/.DS_Store`]: "file-nonempty",
			[`${parent}/README`]: "file-nonempty",
			[`${parent}/1.2`]: "file-nonempty",
		});
		expect(scanClaudeCodeDirs(parent, fs)).toStrictEqual([]);
	});

	it("version-shaped file (not a directory) → other 'not-a-directory'", () => {
		const v = "1.2.3";
		const fs = fakeFs({ [`${parent}/${v}`]: "file-nonempty" });
		expect(scanClaudeCodeDirs(parent, fs)).toStrictEqual([
			{ path: `${parent}/${v}`, version: v, kind: "other", reason: "not-a-directory" },
		]);
	});

	it("stat that throws mid-scan → other 'stat-failed' (doesn't abort the whole scan)", () => {
		const v = "1.2.3";
		const fs: FsPort = {
			readdirSync: () => [v],
			statSync: failOnStat(`${parent}/${v}`),
			existsSync: () => true,
		};
		expect(scanClaudeCodeDirs(parent, fs)[0]).toStrictEqual({
			path: `${parent}/${v}`,
			version: v,
			kind: "other",
			reason: "stat-failed",
		});
	});

	it("missing `claude` binary → other 'missing-claude'", () => {
		const v = "1.2.3";
		const macos = macosOf(v);
		const fs = fakeFs({
			[`${parent}/${v}`]: "dir",
			[macos]: "dir",
		});
		expect(scanClaudeCodeDirs(parent, fs)[0]).toStrictEqual({
			path: `${parent}/${v}`,
			version: v,
			kind: "other",
			reason: "missing-claude",
		});
	});

	it("statSync on claude.real that throws mid-classification treats real as empty → other", () => {
		// Adversarial fs where existsSync(real) is true but statSync(real) throws.
		const v = "1.2.3";
		const macos = macosOf(v);
		const paths = new Set<string>([
			`${parent}/${v}`,
			macos,
			`${macos}/claude`,
			`${macos}/claude.real`,
		]);
		const fs: FsPort = {
			readdirSync: () => [v],
			statSync: failOnStat(`${macos}/claude.real`),
			existsSync: (p) => paths.has(p),
		};
		expect(scanClaudeCodeDirs(parent, fs)[0]).toStrictEqual({
			path: `${parent}/${v}`,
			version: v,
			kind: "other",
			reason: "empty-claude-real",
		});
	});

	it("paths returned are joined absolute paths under parentDir", () => {
		const v = "9.9.9";
		const macos = macosOf(v);
		const fs = fakeFs({
			[`${parent}/${v}`]: "dir",
			[macos]: "dir",
			[`${macos}/claude`]: "file-nonempty",
		});
		expect(scanClaudeCodeDirs(parent, fs)[0]?.path).toBe(join(parent, v));
	});
});
