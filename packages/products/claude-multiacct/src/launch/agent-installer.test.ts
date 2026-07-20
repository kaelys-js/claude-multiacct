/**
 * Intent: PR5a stays GATED. `installAgent` and `uninstallAgent` must be
 * hard no-ops unless CLAUDE_MULTIACCT_ENABLE_SHIM=1 (or `{overrideFlag:true}`
 * for tests). If either function starts touching `~/Library/LaunchAgents`
 * or invoking launchctl when the flag is off, the whole PR breaks its
 * default-off ship contract. The flag-off tests here are the load-bearing
 * tripwires (adversarial: bypass the gate on either installAgent OR
 * uninstallAgent and the corresponding test flips red).
 *
 * The idempotency + snapshot + reload cases pin the mechanics: unchanged
 * body → no-op, changed body → snapshot + rewrite + bootout+bootstrap.
 * The plist body assertion cross-checks that the daemon plist we render
 * bakes in the CLAUDE_MULTIACCT_ENABLE_SHIM=1 env var (drop → red on the
 * launchd-plist adversarial test AND, transitively, here).
 */

import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentFsPort,
	defaultBackupsRoot,
	defaultPlistDir,
	installAgent,
	nodeAgentFsPort,
	nodeLaunchctlPort,
	statusAgent,
	uninstallAgent,
} from "./agent-installer.ts";
import { DAEMON_LABEL, renderDaemonPlist } from "./launchd-plist.ts";

type FakeFs = {
	files: Map<string, string>;
	dirs: Set<string>;
	port: AgentFsPort;
};

function makeAgentFs(): FakeFs {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const port: AgentFsPort = {
		readFile: (p) => {
			const v = files.get(p);
			if (v === undefined) {
				return Promise.reject(new Error(`ENOENT ${p}`));
			}
			return Promise.resolve(v);
		},
		writeFile: (p, d) => {
			files.set(p, d);
			return Promise.resolve();
		},
		mkdir: (p) => {
			dirs.add(p);
			return Promise.resolve();
		},
		rm: (p) => {
			files.delete(p);
			return Promise.resolve();
		},
		copyFile: (src, dest) => {
			const v = files.get(src);
			if (v === undefined) {
				return Promise.reject(new Error(`ENOENT ${src}`));
			}
			files.set(dest, v);
			return Promise.resolve();
		},
		exists: (p) => Promise.resolve(files.has(p) || dirs.has(p)),
	};
	return { files, dirs, port };
}

type BootstrapFn = (uid: number, plistPath: string) => Promise<void>;
type BootoutFn = (uid: number, label: string) => Promise<void>;
type PrintFn = (uid: number, label: string) => Promise<{ loaded: boolean }>;
type LogFn = (m: string) => void;

type FakeLaunchctl = {
	bootstrap: ReturnType<typeof vi.fn<BootstrapFn>>;
	bootout: ReturnType<typeof vi.fn<BootoutFn>>;
	print: ReturnType<typeof vi.fn<PrintFn>>;
};

const resolvedVoid: BootstrapFn = () => Promise.resolve();
const resolvedLoaded: PrintFn = () => Promise.resolve({ loaded: true });

function makeLaunchctl(overrides: Partial<FakeLaunchctl> = {}): FakeLaunchctl {
	return {
		bootstrap: overrides.bootstrap ?? vi.fn<BootstrapFn>(resolvedVoid),
		bootout: overrides.bootout ?? vi.fn<BootoutFn>(resolvedVoid),
		print: overrides.print ?? vi.fn<PrintFn>(resolvedLoaded),
	};
}

const plistDir = "/fake/LaunchAgents";
const backupsRoot = "/fake/backups";
const plistPath = join(plistDir, `${DAEMON_LABEL}.plist`);
const uid = 501;
const body = "<plist>example</plist>";
const flagOnEnv = { CLAUDE_MULTIACCT_ENABLE_SHIM: "1" };

describe("defaultPlistDir / defaultBackupsRoot", () => {
	it("resolve under the user's home to the documented conventions", () => {
		expect(defaultPlistDir()).toMatch(/Library\/LaunchAgents$/u);
		expect(defaultBackupsRoot()).toMatch(/\.claude-multiacct-backups$/u);
	});
});

describe("installAgent — flag gate (adversarial: bypass and this goes red)", () => {
	it("flag unset → {skipped:true}, no writes, no launchctl calls", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const log = vi.fn<LogFn>();
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: {},
			log,
		});
		expect(result).toStrictEqual({
			skipped: true,
			reason: expect.stringMatching(/CLAUDE_MULTIACCT_ENABLE_SHIM/u),
		});
		expect(fs.files.size).toBe(0);
		expect(fs.dirs.size).toBe(0);
		expect(lc.bootstrap).not.toHaveBeenCalled();
		expect(lc.bootout).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/refusing to modify LaunchAgents/u));
	});

	it("flag wrong value ('true') → still skipped (only '1' arms it)", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: { CLAUDE_MULTIACCT_ENABLE_SHIM: "true" },
		});
		expect(result).toMatchObject({ skipped: true });
	});

	it("{overrideFlag:true} runs even without the env var (test knob)", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: {},
			overrideFlag: true,
		});
		expect(result).toMatchObject({ skipped: false, wrote: true });
	});
});

describe("installAgent — mechanics", () => {
	let fs: FakeFs;
	let lc: FakeLaunchctl;
	beforeEach(() => {
		fs = makeAgentFs();
		lc = makeLaunchctl();
	});

	it("first install: writes plist body byte-for-byte, bootstraps with expected argv", async () => {
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
		});
		expect(result).toStrictEqual({
			skipped: false,
			wrote: true,
			reloaded: false,
			backup: undefined,
		});
		expect(fs.files.get(plistPath)).toBe(body);
		expect(lc.bootstrap).toHaveBeenCalledWith(uid, plistPath);
	});

	it("second install with identical body → no-op (no snapshot, no reload)", async () => {
		await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
		});
		lc.bootstrap.mockClear();
		lc.bootout.mockClear();
		const before = fs.files.size;
		const log = vi.fn<LogFn>();
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
			log,
		});
		expect(result).toStrictEqual({
			skipped: false,
			wrote: false,
			reloaded: false,
			backup: undefined,
		});
		expect(fs.files.size).toBe(before);
		expect(lc.bootstrap).not.toHaveBeenCalled();
		expect(lc.bootout).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/unchanged/u));
	});

	it("second install with CHANGED body → snapshot + rewrite + bootout+bootstrap", async () => {
		await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
		});
		lc.bootstrap.mockClear();
		const newBody = `${body}\n<!-- changed -->`;
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: newBody,
			env: flagOnEnv,
		});
		expect(result).toMatchObject({ skipped: false, wrote: true, reloaded: true });
		expect(fs.files.get(plistPath)).toBe(newBody);
		expect(lc.bootout).toHaveBeenCalledWith(uid, DAEMON_LABEL);
		expect(lc.bootstrap).toHaveBeenCalledWith(uid, plistPath);
		const okResult = result as Extract<typeof result, { skipped: false }>;
		const backupDir = okResult.backup as string;
		expect(fs.files.get(join(backupDir, `${DAEMON_LABEL}.plist`))).toBe(body);
	});

	it("bootout failure (agent not currently loaded) is swallowed; bootstrap still runs", async () => {
		await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
		});
		const failingBootout = vi.fn<BootoutFn>(() => Promise.reject(new Error("not loaded")));
		const bootstrap2 = vi.fn<BootstrapFn>(resolvedVoid);
		const result = await installAgent({
			launchctl: {
				bootstrap: bootstrap2,
				bootout: failingBootout,
				print: vi.fn<PrintFn>(resolvedLoaded),
			},
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: `${body}\n2`,
			env: flagOnEnv,
		});
		expect(result).toMatchObject({ skipped: false, wrote: true, reloaded: true });
		expect(failingBootout).toHaveBeenCalled();
		expect(bootstrap2).toHaveBeenCalled();
	});

	it("uses the real daemon plist body — CLAUDE_MULTIACCT_ENABLE_SHIM=1 is present (drop it → RED)", async () => {
		const realBody = renderDaemonPlist({
			label: DAEMON_LABEL,
			programArgs: ["/usr/bin/node", "/opt/daemon.js"],
			stdoutPath: "/tmp/daemon.out",
			stderrPath: "/tmp/daemon.err",
		});
		await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: realBody,
			env: flagOnEnv,
		});
		const written = fs.files.get(plistPath) as string;
		expect(written).toContain("<key>CLAUDE_MULTIACCT_ENABLE_SHIM</key>");
		expect(written).toContain("<string>1</string>");
	});
});

describe("uninstallAgent — flag gate + mechanics", () => {
	it("flag off → skipped, no writes, no launchctl calls (adversarial: bypass and this trips)", async () => {
		const fs = makeAgentFs();
		fs.files.set(plistPath, body);
		const lc = makeLaunchctl();
		const result = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			env: {},
		});
		expect(result).toMatchObject({ skipped: true });
		expect(fs.files.has(plistPath)).toBe(true);
		expect(lc.bootout).not.toHaveBeenCalled();
	});

	it("plist missing → removed=false, no snapshot", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			env: flagOnEnv,
		});
		expect(result).toStrictEqual({ skipped: false, removed: false, backup: undefined });
	});

	it("plist present → snapshots, boots out, removes file", async () => {
		const fs = makeAgentFs();
		fs.files.set(plistPath, body);
		const lc = makeLaunchctl();
		const result = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			env: flagOnEnv,
		});
		expect(result).toMatchObject({ skipped: false, removed: true });
		expect(fs.files.has(plistPath)).toBe(false);
		expect(lc.bootout).toHaveBeenCalledWith(uid, DAEMON_LABEL);
		const okResult = result as Extract<typeof result, { skipped: false }>;
		expect(fs.files.get(join(okResult.backup as string, `${DAEMON_LABEL}.plist`))).toBe(body);
	});

	it("bootout failure while file present is swallowed and file is still removed", async () => {
		const fs = makeAgentFs();
		fs.files.set(plistPath, body);
		const lc = makeLaunchctl({
			bootout: vi.fn<BootoutFn>(() => Promise.reject(new Error("not loaded"))),
		});
		const result = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			env: flagOnEnv,
		});
		expect(result).toMatchObject({ skipped: false, removed: true });
		expect(fs.files.has(plistPath)).toBe(false);
	});
});

describe("default-path branches (?? defaults)", () => {
	it("installAgent uses defaultPlistDir + defaultBackupsRoot when omitted", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistBody: body,
			env: flagOnEnv,
		});
		expect(result).toMatchObject({ skipped: false, wrote: true });
	});

	it("uninstallAgent uses defaultPlistDir + defaultBackupsRoot when omitted", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			env: flagOnEnv,
		});
		expect(result).toMatchObject({ skipped: false, removed: false });
	});

	it("statusAgent uses defaultPlistDir when omitted", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl({
			print: vi.fn<PrintFn>(() => Promise.resolve({ loaded: false })),
		});
		const r = await statusAgent({ launchctl: lc, fs: fs.port, uid });
		expect(r.plistExists).toBe(false);
	});
});

describe("statusAgent", () => {
	it("plist absent, agent unloaded → both false", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl({
			print: vi.fn<PrintFn>(() => Promise.resolve({ loaded: false })),
		});
		const r = await statusAgent({ launchctl: lc, fs: fs.port, uid, plistDir });
		expect(r).toStrictEqual({ plistExists: false, loaded: false, plistPath });
	});

	it("plist present, agent loaded → both true", async () => {
		const fs = makeAgentFs();
		fs.files.set(plistPath, body);
		const lc = makeLaunchctl();
		const r = await statusAgent({ launchctl: lc, fs: fs.port, uid, plistDir });
		expect(r).toStrictEqual({ plistExists: true, loaded: true, plistPath });
	});
});

describe("real port factories", () => {
	it("nodeAgentFsPort exposes the AgentFsPort shape (exists returns false for missing paths)", async () => {
		const port = nodeAgentFsPort();
		expect(await port.exists("/definitely/not/a/real/path/for/tests")).toBe(false);
	});

	it("nodeAgentFsPort read/write/mkdir/rm/copyFile round-trip against a real tmpdir", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const root = await mkdtemp(`${tmpdir()}/cma-agentfs-`);
		const port = nodeAgentFsPort();
		const sub = join(root, "sub");
		await port.mkdir(sub, { recursive: true });
		const a = join(sub, "a.txt");
		await port.writeFile(a, "hello");
		expect(await port.readFile(a)).toBe("hello");
		expect(await port.exists(a)).toBe(true);
		const b = join(sub, "b.txt");
		await port.copyFile(a, b);
		expect(await port.readFile(b)).toBe("hello");
		await port.rm(a);
		expect(await port.exists(a)).toBe(false);
	});

	it("nodeLaunchctlPort exposes the LaunchctlPort shape (print of missing agent → loaded=false)", async () => {
		const port = nodeLaunchctlPort({
			execFile: () => {
				throw new Error("not loaded");
			},
		});
		const r = await port.print(uid, DAEMON_LABEL);
		expect(r.loaded).toBe(false);
	});

	it("nodeLaunchctlPort.print → loaded=true when execFile succeeds", async () => {
		const port = nodeLaunchctlPort({
			execFile: () => Promise.resolve({ stdout: "ok", stderr: "" }),
		});
		const r = await port.print(uid, DAEMON_LABEL);
		expect(r.loaded).toBe(true);
	});

	it("nodeLaunchctlPort.bootstrap/bootout call through to injected execFile", async () => {
		const exec = vi.fn<
			(file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
		>(() => Promise.resolve({ stdout: "", stderr: "" }));
		const port = nodeLaunchctlPort({ execFile: exec });
		await port.bootstrap(uid, plistPath);
		await port.bootout(uid, DAEMON_LABEL);
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("nodeLaunchctlPort defaults execFile to the promisified node:child_process one", () => {
		const port = nodeLaunchctlPort();
		// Just prove the factory returns the shape; we don't invoke to
		// avoid shelling out. If the default binding were missing, this
		// call would throw on port construction.
		expect(typeof port.bootstrap).toBe("function");
		expect(typeof port.bootout).toBe("function");
		expect(typeof port.print).toBe("function");
	});
});
