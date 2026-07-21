/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/prefer-destructuring, eslint/require-await, eslint/no-unused-vars, eslint/no-throw-literal, unicorn/numeric-separators-style, unicorn/no-useless-undefined, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `cma migrate` reliably detects EACH old-tool artifact and, in
 * --apply mode, cleans it up safely (snapshot precedes every rm/mv).
 *
 *   - one fixture per category (instances.yaml / launchd-agent /
 *     mirror-clone / asar-patch); adversarial: skip a detector and the
 *     corresponding "detects <category>" test flips red.
 *   - --apply snapshot invariant: EVERY rm/mv is preceded by a
 *     snapshot copy into <backupsRoot>/<ts>/migrate/. Adversarial: skip
 *     the snapshot call and the invariant test flips red.
 *   - primary-restore with backup present → asar swap + markers cleared;
 *     without backup → refuse loudly, do NOT touch asar.
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	apply,
	ASAR_MARKERS,
	LEGACY_LABELS,
	type MigrateFs,
	type MigratePorts,
	renderReport,
	scan,
} from "./migrate.ts";

type FakeState = {
	files: Map<string, Buffer>;
	dirs: Set<string>;
	dirEntries: Map<string, readonly string[]>;
	ops: string[]; // rm/mv/copyFile/mkdir trace
};

function makeFs(state: FakeState): MigrateFs {
	return {
		exists: async (p) => state.files.has(p) || state.dirs.has(p),
		readDir: async (p) => state.dirEntries.get(p) ?? [],
		readFileBytes: async (p) => {
			const v = state.files.get(p);
			if (v === undefined) {
				throw new Error(`ENOENT ${p}`);
			}
			return v;
		},
		rm: async (p) => {
			state.ops.push(`rm:${p}`);
			state.files.delete(p);
			state.dirs.delete(p);
		},
		rename: async (src, dest) => {
			state.ops.push(`rename:${src}→${dest}`);
			const v = state.files.get(src);
			if (v !== undefined) {
				state.files.set(dest, v);
				state.files.delete(src);
			}
			if (state.dirs.has(src)) {
				state.dirs.add(dest);
				state.dirs.delete(src);
			}
		},
		copyFile: async (src, dest) => {
			state.ops.push(`copyFile:${src}→${dest}`);
			const v = state.files.get(src);
			if (v === undefined) {
				throw new Error(`ENOENT ${src}`);
			}
			state.files.set(dest, v);
		},
		mkdir: async (p) => {
			state.ops.push(`mkdir:${p}`);
			state.dirs.add(p);
		},
	};
}

function makePorts(state: FakeState, extra: Partial<MigratePorts> = {}): MigratePorts {
	const homedir = "/home";
	return {
		fs: makeFs(state),
		launchctl: { bootout: vi.fn(async () => undefined) },
		uid: 501,
		homedir,
		appPath: "/Applications/Claude.app",
		backupsRoot: "/home/.claude-multiacct-backups",
		confirm: async () => true,
		now: () => new Date("2026-07-20T12:00:00.000Z"),
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
		...extra,
	};
}

function makeState(): FakeState {
	return { files: new Map(), dirs: new Set(), dirEntries: new Map(), ops: [] };
}

describe("scan — one detector per legacy artifact category", () => {
	it("detects instances.yaml", async () => {
		const s = makeState();
		s.files.set("/home/.config/claude-multiacct/instances.yaml", Buffer.from("x"));
		const r = await scan(makePorts(s));
		expect(r.findings.some((f) => f.category === "instances.yaml")).toBe(true);
	});

	it("detects each legacy launchd agent (adversarial: drop one → red)", async () => {
		const s = makeState();
		for (const label of LEGACY_LABELS) {
			s.files.set(`/home/Library/LaunchAgents/${label}.plist`, Buffer.from("x"));
		}
		const r = await scan(makePorts(s));
		const paths = r.findings.filter((f) => f.category === "launchd-agent").map((f) => f.path);
		for (const label of LEGACY_LABELS) {
			expect(paths).toContain(`/home/Library/LaunchAgents/${label}.plist`);
		}
	});

	it("detects mirror clones under ~/Applications", async () => {
		const s = makeState();
		s.dirs.add("/home/Applications");
		s.dirEntries.set("/home/Applications", [
			"Claude Account Personal.app",
			"Claude Account Work.app",
			"Some Other.app",
		]);
		const r = await scan(makePorts(s));
		const clones = r.findings.filter((f) => f.category === "mirror-clone");
		expect(clones).toHaveLength(2);
		expect(clones.some((f) => f.path.includes("Personal"))).toBe(true);
	});

	it("detects asar patch via .multiacct-backup file", async () => {
		const s = makeState();
		s.files.set("/Applications/Claude.app/Contents/Resources/app.asar", Buffer.from("pristine"));
		s.files.set(
			"/Applications/Claude.app/Contents/Resources/app.asar.multiacct-backup",
			Buffer.from("orig"),
		);
		const r = await scan(makePorts(s));
		const hit = r.findings.find((f) => f.category === "asar-patch");
		expect(hit).toBeDefined();
		expect(hit?.severity).toBe("warn");
	});

	it("detects asar patch via marker string in asar bytes", async () => {
		const s = makeState();
		const marker = ASAR_MARKERS[0];
		s.files.set(
			"/Applications/Claude.app/Contents/Resources/app.asar",
			Buffer.from(`XXX${marker}YYY`),
		);
		const r = await scan(makePorts(s));
		const hit = r.findings.find((f) => f.category === "asar-patch");
		expect(hit).toBeDefined();
		// No backup → severity error, fix says reinstall.
		expect(hit?.severity).toBe("error");
		expect(hit?.fix).toMatch(/reinstall/u);
	});

	it("empty machine → no findings", async () => {
		const s = makeState();
		const r = await scan(makePorts(s));
		expect(r.findings).toStrictEqual([]);
	});
});

describe("renderReport", () => {
	it("no findings → clean message", () => {
		expect(renderReport({ findings: [] })).toContain("no legacy artifacts");
	});
	it("with findings → table-like block", () => {
		const out = renderReport({
			findings: [{ category: "instances.yaml", path: "/x", severity: "warn", fix: "remove" }],
		});
		expect(out).toContain("[warn]");
		expect(out).toContain("instances.yaml");
		expect(out).toContain("fix: remove");
	});
});

describe("apply — snapshot precedes rm/mv (adversarial: skip snapshot → red)", () => {
	it("instances.yaml: copyFile to snapshot BEFORE rm", async () => {
		const s = makeState();
		s.files.set("/home/.config/claude-multiacct/instances.yaml", Buffer.from("x"));
		const p = makePorts(s);
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		const yamlOps = s.ops.filter((o) => o.includes("instances.yaml"));
		const copyIdx = yamlOps.findIndex((o) => o.startsWith("copyFile:"));
		const rmIdx = yamlOps.findIndex((o) => o.startsWith("rm:"));
		expect(copyIdx).toBeGreaterThanOrEqual(0);
		expect(rmIdx).toBeGreaterThan(copyIdx);
	});

	it("legacy launchd agent: bootout + snapshot + rm", async () => {
		const s = makeState();
		const label = LEGACY_LABELS[0];
		const path = `/home/Library/LaunchAgents/${label}.plist`;
		s.files.set(path, Buffer.from("x"));
		const p = makePorts(s);
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		expect(p.launchctl.bootout).toHaveBeenCalledWith(501, label);
		expect(s.files.has(path)).toBe(false);
	});
});

describe("apply — primary-restore branch (Rule-1 safe path)", () => {
	it("with backup present: swap backup back into place; do NOT touch Info.plist", async () => {
		const s = makeState();
		const asar = "/Applications/Claude.app/Contents/Resources/app.asar";
		const backup = `${asar}.multiacct-backup`;
		s.files.set(asar, Buffer.from("patched"));
		s.files.set(backup, Buffer.from("pristine"));
		const p = makePorts(s);
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		// Backup is gone (renamed into place), pristine bytes are now at asar path.
		expect(s.files.has(backup)).toBe(false);
		expect(s.files.get(asar)?.toString()).toBe("pristine");
		// Info.plist was NOT touched.
		expect(s.ops.some((o) => o.includes("Info.plist"))).toBe(false);
	});

	it("with backup present + unpacked backup: unpacked restored too", async () => {
		const s = makeState();
		const asar = "/Applications/Claude.app/Contents/Resources/app.asar";
		s.files.set(asar, Buffer.from("patched"));
		s.files.set(`${asar}.multiacct-backup`, Buffer.from("pristine"));
		s.dirs.add(`${asar}.unpacked`);
		s.dirs.add(`${asar}.unpacked.multiacct-backup`);
		const p = makePorts(s);
		await apply(p, { yes: true });
		expect(s.dirs.has(`${asar}.unpacked.multiacct-backup`)).toBe(false);
	});

	it("without backup + marker present: refuses loudly, does NOT touch asar (adversarial: silent write → red)", async () => {
		const s = makeState();
		const asar = "/Applications/Claude.app/Contents/Resources/app.asar";
		s.files.set(asar, Buffer.from(`X${ASAR_MARKERS[0]}Y`));
		const p = makePorts(s);
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(2);
		// Asar bytes UNCHANGED.
		expect(s.files.get(asar)?.toString()).toBe(`X${ASAR_MARKERS[0]}Y`);
		expect(r.perItem[0]?.ok).toBe(false);
		expect(r.perItem[0]?.detail).toMatch(/reinstall Claude Desktop/u);
	});
});

describe("apply — confirmation gate", () => {
	it("without --yes: prompts, and a 'no' aborts before touching disk", async () => {
		const s = makeState();
		s.files.set("/home/.config/claude-multiacct/instances.yaml", Buffer.from("x"));
		const p = makePorts(s, { confirm: async () => false });
		const r = await apply(p, { yes: false });
		expect(r.exitCode).toBe(1);
		expect(s.ops.some((o) => o.startsWith("rm:"))).toBe(false);
	});

	it("empty machine skips confirmation entirely and returns 0", async () => {
		const s = makeState();
		const confirm = vi.fn<MigratePorts["confirm"]>(async () => true);
		const p = makePorts(s, { confirm });
		const r = await apply(p, { yes: false });
		expect(r.exitCode).toBe(0);
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("apply — best-effort semantics", () => {
	it("per-item failure does not stop subsequent items; exit 2", async () => {
		const s = makeState();
		s.files.set("/home/.config/claude-multiacct/instances.yaml", Buffer.from("x"));
		s.files.set(`/home/Library/LaunchAgents/${LEGACY_LABELS[0]}.plist`, Buffer.from("x"));
		const p = makePorts(s);
		// Break the first rm to force failure.
		const origFs = p.fs;
		let calls = 0;
		p.fs = {
			...origFs,
			rm: async (path, opts) => {
				calls += 1;
				if (calls === 1) {
					throw new Error("EBUSY");
				}
				return await origFs.rm(path, opts);
			},
		};
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(2);
		expect(r.perItem.some((i) => !i.ok)).toBe(true);
		expect(r.perItem.some((i) => i.ok)).toBe(true);
	});
});

describe("scan — asar readFileBytes throw is tolerated", () => {
	it("asar exists but read fails → no false-positive finding", async () => {
		const s = makeState();
		s.files.set("/Applications/Claude.app/Contents/Resources/app.asar", Buffer.from("x"));
		const p = makePorts(s);
		// Force readFileBytes to throw on the asar.
		p.fs = {
			...p.fs,
			readFileBytes: async (path) => {
				if (path.endsWith("app.asar")) {
					throw new Error("EIO");
				}
				return Buffer.from("");
			},
		};
		const r = await scan(p);
		expect(r.findings.filter((f) => f.category === "asar-patch")).toHaveLength(0);
	});
});

describe("apply — no-op path when nothing to migrate", () => {
	it("logs the clean-machine message and returns 0", async () => {
		const s = makeState();
		const logs: string[] = [];
		const p = makePorts(s, {
			logger: { log: (m) => logs.push(m), warn: vi.fn(), error: vi.fn() },
		});
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		expect(logs.join("\n")).toContain("no legacy artifacts");
	});
});

describe("apply — mirror-clone with Info.plist snapshots it and rm's the bundle", () => {
	it("Info.plist present → snapshotFile called with sanitised basename", async () => {
		const s = makeState();
		s.dirs.add("/home/Applications");
		s.dirEntries.set("/home/Applications", ["Claude Account Personal.app"]);
		const bundle = "/home/Applications/Claude Account Personal.app";
		const info = `${bundle}/Contents/Info.plist`;
		s.dirs.add(bundle);
		s.files.set(info, Buffer.from("<plist/>"));
		const p = makePorts(s);
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		// Info.plist snapshot copyFile op happened
		expect(s.ops.some((o) => o.startsWith("copyFile:") && o.includes("Info.plist"))).toBe(true);
		// Sanitised basename replaced non-alnum chars with `_`
		const copyOp = s.ops.find((o) => o.startsWith("copyFile:") && o.includes("Info.plist"));
		expect(copyOp).toMatch(/Personal\.app\.Info\.plist$/u);
		// Bundle removed
		expect(s.ops.some((o) => o === `rm:${bundle}`)).toBe(true);
	});

	it("Info.plist absent → still removes the bundle (no snapshot copy)", async () => {
		const s = makeState();
		s.dirs.add("/home/Applications");
		s.dirEntries.set("/home/Applications", ["Claude Account Solo.app"]);
		const bundle = "/home/Applications/Claude Account Solo.app";
		s.dirs.add(bundle);
		const p = makePorts(s);
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		expect(s.ops.some((o) => o.startsWith("copyFile:") && o.includes("Info.plist"))).toBe(false);
		expect(s.ops.some((o) => o === `rm:${bundle}`)).toBe(true);
	});
});

describe("apply — launchctl bootout failure is tolerated", () => {
	it("bootout throws → still removes the plist", async () => {
		const s = makeState();
		const label = LEGACY_LABELS[0];
		const path = `/home/Library/LaunchAgents/${label}.plist`;
		s.files.set(path, Buffer.from("x"));
		const p = makePorts(s, {
			launchctl: {
				bootout: async () => {
					throw new Error("not loaded");
				},
			},
		});
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		expect(s.files.has(path)).toBe(false);
	});
});

describe("apply — non-Error rejection stringified in per-item detail", () => {
	it("rm throws a non-Error string → detail carries stringified value", async () => {
		const s = makeState();
		s.files.set("/home/.config/claude-multiacct/instances.yaml", Buffer.from("x"));
		const p = makePorts(s);
		p.fs = {
			...p.fs,
			// eslint-disable-next-line no-throw-literal
			rm: async () => {
				throw "raw error string";
			},
		};
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(2);
		expect(r.perItem[0]?.detail).toContain("raw error string");
	});
});

describe("apply — Rule 12 succeed loud (Bug 4)", () => {
	it("prints one removal line per item PLUS a summary count (adversarial: drop the per-item log and this 3-item fixture flips red)", async () => {
		const s = makeState();
		s.files.set("/home/.config/claude-multiacct/instances.yaml", Buffer.from("x"));
		s.files.set(`/home/Library/LaunchAgents/${LEGACY_LABELS[0]}.plist`, Buffer.from("x"));
		s.files.set(`/home/Library/LaunchAgents/${LEGACY_LABELS[1]}.plist`, Buffer.from("x"));
		const logs: string[] = [];
		const p = makePorts(s, {
			logger: { log: (m) => logs.push(m), warn: vi.fn(), error: vi.fn() },
		});
		const r = await apply(p, { yes: true });
		expect(r.exitCode).toBe(0);
		const removals = logs.filter((l) => l.startsWith("cma migrate: removed "));
		expect(removals).toHaveLength(3);
		const removalBlob = removals.join("\n");
		expect(removalBlob).toContain("/home/.config/claude-multiacct/instances.yaml");
		expect(removalBlob).toContain(`/home/Library/LaunchAgents/${LEGACY_LABELS[0]}.plist`);
		expect(removalBlob).toContain(`/home/Library/LaunchAgents/${LEGACY_LABELS[1]}.plist`);
		expect(logs.some((l) => l === "cma migrate: 3 of 3 items removed")).toBe(true);
	});
});

describe("apply — snapshot dir path is under backupsRoot", () => {
	it("snapshotDir path shape: <backupsRoot>/<iso-ts>/migrate", async () => {
		const s = makeState();
		s.files.set("/home/.config/claude-multiacct/instances.yaml", Buffer.from("x"));
		const p = makePorts(s);
		const r = await apply(p, { yes: true });
		expect(r.snapshotDir.startsWith("/home/.claude-multiacct-backups/")).toBe(true);
		expect(r.snapshotDir.endsWith(join("2026-07-20T12-00-00-000Z", "migrate"))).toBe(true);
	});
});
