/**
 * Intent: PR3 stays GATED. `installAgent` and `uninstallAgent` must be
 * hard-no-ops unless CLAUDE_MULTIACCT_ENABLE_SHIM=1 (or {overrideFlag:true}
 * for tests). If either function starts modifying `~/Library/LaunchAgents`
 * or invoking launchctl when the flag is off, the whole PR breaks its
 * default-off ship contract. The flag-off tests below are the load-bearing
 * assertion — bypass the gate in agent-installer.ts and they immediately
 * flip red.
 *
 * The idempotency + snapshot + reload cases pin the mechanics: unchanged
 * body → no-op, changed body → snapshot + rewrite + bootout+bootstrap.
 * `statusAgent` is exercised with both loaded and unloaded launchctl print
 * outcomes; it always runs regardless of the flag.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentFsPort,
	defaultBackupsRoot,
	defaultPlistDir,
	installAgent,
	type LaunchctlPort,
	nodeAgentFsPort,
	nodeLaunchctlPort,
	statusAgent,
	uninstallAgent,
} from "./agent-installer.ts";
import { WATCHER_LABEL } from "./launchd-plist.ts";

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
const plistPath = join(plistDir, `${WATCHER_LABEL}.plist`);
const uid = 501;
const body = "<plist>example</plist>";
const flagOnEnv = { CLAUDE_MULTIACCT_ENABLE_SHIM: "1" };
const currentUid = Number(process.getuid?.() ?? 0);

describe("defaultPlistDir / defaultBackupsRoot", () => {
	it("resolve under the user's home to the documented conventions", () => {
		expect(defaultPlistDir()).toMatch(/Library\/LaunchAgents$/u);
		expect(defaultBackupsRoot()).toMatch(/\.claude-multiacct-backups$/u);
	});
});

describe("installAgent — flag gate (ADVERSARIAL: bypass and this goes red)", () => {
	it("flag unset → {skipped:true}, NO writes, NO launchctl calls", async () => {
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
		expect(lc.bootout).toHaveBeenCalledWith(uid, WATCHER_LABEL);
		expect(lc.bootstrap).toHaveBeenCalledWith(uid, plistPath);
		const okResult = result as Extract<typeof result, { skipped: false }>;
		const backupDir = okResult.backup as string;
		expect(fs.files.get(join(backupDir, `${WATCHER_LABEL}.plist`))).toBe(body);
	});

	it("changed body: bootout failure (agent not currently loaded) is swallowed; bootstrap still runs", async () => {
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

	it("logs the install line when writing a fresh plist", async () => {
		const log = vi.fn<LogFn>();
		await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
			log,
		});
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/installed/u));
	});
});

describe("uninstallAgent", () => {
	it("flag off → skipped, no writes, no launchctl calls", async () => {
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

	it("plist missing → wasInstalled=false, no snapshot", async () => {
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

	it("plist present → snapshots, bootouts, removes file", async () => {
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
		const ok = result as Extract<typeof result, { skipped: false }>;
		expect(fs.files.get(join(ok.backup as string, `${WATCHER_LABEL}.plist`))).toBe(body);
		expect(lc.bootout).toHaveBeenCalledWith(uid, WATCHER_LABEL);
	});

	it("bootout failure during uninstall is swallowed; file removal proceeds", async () => {
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
			overrideFlag: true,
		});
		expect(result).toMatchObject({ skipped: false, removed: true });
		expect(fs.files.has(plistPath)).toBe(false);
	});
});

describe("statusAgent — read-only, ignores the flag", () => {
	it("plist absent + launchctl reports unloaded → both false", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl({
			print: vi.fn<PrintFn>(() => Promise.resolve({ loaded: false })),
		});
		const result = await statusAgent({ launchctl: lc, fs: fs.port, uid, plistDir });
		expect(result).toStrictEqual({ plistExists: false, loaded: false, plistPath });
	});

	it("plist present + launchctl reports loaded → both true", async () => {
		const fs = makeAgentFs();
		fs.files.set(plistPath, body);
		const lc = makeLaunchctl();
		const result = await statusAgent({ launchctl: lc, fs: fs.port, uid, plistDir });
		expect(result).toStrictEqual({ plistExists: true, loaded: true, plistPath });
	});
});

describe("nodeLaunchctlPort / nodeAgentFsPort — real bindings smoke-test", () => {
	it("nodeLaunchctlPort dispatches bootstrap/bootout/print through the injected execFile", async () => {
		const calls: Array<{ file: string; args: readonly string[] }> = [];
		const exec = vi.fn<
			(file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
		>((file, args) => {
			calls.push({ file, args });
			return Promise.resolve({ stdout: "", stderr: "" });
		});
		const port: LaunchctlPort = nodeLaunchctlPort({ execFile: exec });
		await port.bootstrap(501, "/some/plist");
		await port.bootout(501, "com.example");
		const ok = await port.print(501, "com.example");
		expect(ok).toStrictEqual({ loaded: true });
		expect(calls).toStrictEqual([
			{ file: "launchctl", args: ["bootstrap", "gui/501", "/some/plist"] },
			{ file: "launchctl", args: ["bootout", "gui/501/com.example"] },
			{ file: "launchctl", args: ["print", "gui/501/com.example"] },
		]);
	});

	it("nodeLaunchctlPort.print returns {loaded:false} when execFile rejects", async () => {
		const port = nodeLaunchctlPort({
			execFile: () => Promise.reject(new Error("not loaded")),
		});
		expect(await port.print(501, "com.example.missing")).toStrictEqual({ loaded: false });
	});

	it("nodeLaunchctlPort with default execFile resolves to a real launchctl-backed impl", async () => {
		const port = nodeLaunchctlPort();
		const result = await port.print(currentUid, "com.claude-multiacct.watcher.does-not-exist");
		expect(result).toStrictEqual({ loaded: false });
	});

	it("nodeAgentFsPort.exists/writeFile/readFile/rm/copyFile/mkdir round-trip on a real tmpdir", async () => {
		const root = await mkdtemp(join(tmpdir(), "cma-agentfs-"));
		const port = nodeAgentFsPort();
		expect(await port.exists(join(root, "nope"))).toBe(false);
		await port.mkdir(join(root, "d"), { recursive: true });
		expect(await port.exists(join(root, "d"))).toBe(true);
		const a = join(root, "d", "a");
		const b = join(root, "d", "b");
		await port.writeFile(a, "hello");
		expect(await port.readFile(a)).toBe("hello");
		await port.copyFile(a, b);
		expect(await port.readFile(b)).toBe("hello");
		await port.rm(a);
		expect(await port.exists(a)).toBe(false);
	});
});

describe("installAgent / uninstallAgent / statusAgent — default path fallbacks", () => {
	// Exercise the `plistDir ?? defaultPlistDir()` + `backups ?? defaultBackupsRoot()`
	// branches. The fake fs is in-memory, so real ~/Library/LaunchAgents is never touched.
	it("installAgent with overrideFlag + no plistDir/backups → writes under defaultPlistDir()", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistBody: body,
			overrideFlag: true,
			env: {},
		});
		expect(result).toMatchObject({ skipped: false, wrote: true });
		const writtenPaths = [...fs.files.keys()];
		expect(
			writtenPaths.some((p) => p.endsWith(`Library/LaunchAgents/${WATCHER_LABEL}.plist`)),
		).toBe(true);
	});

	it("uninstallAgent with overrideFlag + no plistDir/backups → default paths, no-op on empty fs", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			overrideFlag: true,
			env: {},
		});
		expect(result).toStrictEqual({ skipped: false, removed: false, backup: undefined });
	});

	it("statusAgent with no plistDir → resolves the default LaunchAgents path", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl({
			print: vi.fn<PrintFn>(() => Promise.resolve({ loaded: false })),
		});
		const result = await statusAgent({ launchctl: lc, fs: fs.port, uid });
		expect(result.plistPath).toMatch(
			/Library\/LaunchAgents\/com\.claude-multiacct\.watcher\.plist$/u,
		);
		expect(result.plistExists).toBe(false);
	});
});

describe("installAgent / uninstallAgent — default-arg process.env path", () => {
	// CI unsets CLAUDE_MULTIACCT_ENABLE_SHIM, so with no `env` override the
	// mutating ops must short-circuit into {skipped:true}. That covers the
	// `deps.env ?? process.env` fallback branch WITHOUT writing anything.
	it("installAgent with no env override → falls back to process.env, stays skipped", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		delete process.env.CLAUDE_MULTIACCT_ENABLE_SHIM;
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
		});
		expect(result).toMatchObject({ skipped: true });
		expect(fs.files.size).toBe(0);
	});

	it("uninstallAgent with no env override → same fallback, still skipped", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		delete process.env.CLAUDE_MULTIACCT_ENABLE_SHIM;
		const result = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
		});
		expect(result).toMatchObject({ skipped: true });
	});
});

describe("installAgent / uninstallAgent — CLI-authoritative {flag} param (PR6b)", () => {
	it("installAgent {flag:true} runs with env UNSET", async () => {
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
			flag: true,
		});
		expect(result).toMatchObject({ skipped: false, wrote: true });
	});
	it("installAgent {flag:false} SKIPS even with env SET (adversarial: drop precedence → red)", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		const result = await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
			flag: false,
		});
		expect(result).toStrictEqual({
			skipped: true,
			reason: expect.stringMatching(/\{flag:false\}/u),
		});
		expect(fs.files.size).toBe(0);
		expect(lc.bootstrap).not.toHaveBeenCalled();
	});
	it("uninstallAgent {flag:true} runs, {flag:false} skips regardless of env", async () => {
		const fs = makeAgentFs();
		const lc = makeLaunchctl();
		await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
		});
		const ok = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			env: {},
			flag: true,
		});
		expect(ok).toMatchObject({ skipped: false, removed: true });
		await installAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			plistBody: body,
			env: flagOnEnv,
		});
		const skipped = await uninstallAgent({
			launchctl: lc,
			fs: fs.port,
			uid,
			plistDir,
			backups: backupsRoot,
			env: flagOnEnv,
			flag: false,
		});
		expect(skipped).toMatchObject({ skipped: true });
	});
});
