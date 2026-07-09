// Unit tests for the local-CI runner (packages/shared/utils/qa/src/ci-local.ts).
//
// ci-local orchestrates external tools (docker, act, git, mise), so we mock all of
// them and drive `ciLocal(args)` directly. Rule 9 — the guarantees under test are
// the ones that matter operationally: it must FAIL LOUD (exit 1, no act run) when
// Docker is down; it must TEAR DOWN containers after a run and, on `--clean`, also
// drop the runner image + action cache; and it must run the *whole* workflow
// (`act push`, all jobs) rather than a single job. A regression in any of those
// would flip one of these assertions.

import { describe, it, expect, vi, beforeEach } from "vitest";

const miseExecMock =
	vi.fn<(...args: unknown[]) => { status: number | null; stdout: string; stderr: string }>();
const spawnSyncMock =
	vi.fn<(...args: unknown[]) => { status: number | null; stdout: string; stderr: string }>();
const existsSyncMock = vi.fn<(...args: unknown[]) => boolean>();
const rmSyncMock = vi.fn<(...args: unknown[]) => void>();

vi.mock("@foundation/core", () => ({
	repoRoot: (): string => "/repo",
	miseExec: (...args: unknown[]): unknown => miseExecMock(...args),
}));
vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]): unknown => spawnSyncMock(...args),
}));
vi.mock("node:fs", () => ({
	existsSync: (...args: unknown[]): unknown => existsSyncMock(...args),
	rmSync: (...args: unknown[]): unknown => rmSyncMock(...args),
}));
vi.mock("node:os", () => ({ homedir: (): string => "/home/u" }));

const { ciLocal } = await import("../src/ci-local.ts");

const ok = { status: 0, stdout: "", stderr: "" };

// A shell stub that dispatches on the command it receives. `dockerVersion` drives
// the daemon-reachable check; `actContainers` is the `docker ps -aq` output.
function stubShell(opts: { dockerVersion?: number; actContainers?: string } = {}): void {
	const dockerVersion = opts.dockerVersion ?? 0;
	const actContainers = opts.actContainers ?? "";
	spawnSyncMock.mockImplementation((...raw: unknown[]) => {
		const cmd = raw[0] as string;
		const args = raw[1] as string[];
		if (cmd === "docker" && args[0] === "version") {
			return { status: dockerVersion, stdout: "", stderr: "" };
		}
		if (cmd === "docker" && args[0] === "ps") {
			return { status: 0, stdout: actContainers, stderr: "" };
		}
		return ok;
	});
}

// act presence (`act --version`) and the workflow run (`act push`) exit codes.
function stubAct(opts: { present?: boolean; runStatus?: number } = {}): void {
	const present = opts.present ?? true;
	const runStatus = opts.runStatus ?? 0;
	miseExecMock.mockImplementation((...raw: unknown[]) => {
		const args = raw[0] as string[];
		if (args[1] === "--version") {
			return { status: present ? 0 : 1, stdout: "", stderr: "" };
		}
		return { status: runStatus, stdout: "", stderr: "" };
	});
}

// Every spawnSync call as [cmd, args].
function shellCalls(): Array<[string, string[]]> {
	return spawnSyncMock.mock.calls.map((c) => [c[0] as string, c[1] as string[]]);
}
function ranShell(cmd: string, arg0: string): boolean {
	return shellCalls().some(([c, a]) => c === cmd && a[0] === arg0);
}
function actInvocation(): string[] | undefined {
	const call = miseExecMock.mock.calls.find((c) => (c[0] as string[])[1] === "push");
	return call ? (call[0] as string[]) : undefined;
}
function usedGlobalMiseInstall(): boolean {
	return shellCalls().some(([c, a]) => c.endsWith("mise") && a[0] === "use" && a.includes("-g"));
}
function gitCloneArgs(): string[][] {
	return shellCalls()
		.filter(([c, a]) => c === "git" && a.includes("clone"))
		.map(([, a]) => a);
}
// act present for `--version`, but the workflow run reports no exit code at all.
function stubActNoExitCode(): void {
	miseExecMock.mockImplementation((...raw: unknown[]) => {
		const args = raw[0] as string[];
		return args[1] === "--version"
			? { status: 0, stdout: "", stderr: "" }
			: { status: null, stdout: "", stderr: "" };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	existsSyncMock.mockReturnValue(true);
});

describe("ciLocal — run mode", () => {
	it("fails loud (exit 1, no act run) when Docker is not running", () => {
		stubShell({ dockerVersion: 1 });
		stubAct();
		const code = ciLocal([]);
		expect(code).toBe(1);
		expect(actInvocation()).toBeUndefined(); // never tried to run the workflow
	});

	it("runs the WHOLE workflow via `act push` and tears down containers, exit 0", () => {
		stubShell({ actContainers: "abc123\ndef456" });
		stubAct({ present: true, runStatus: 0 });
		const code = ciLocal([]);
		expect(code).toBe(0);
		const act = actInvocation();
		expect(act).toBeDefined();
		expect(act).toContain("push"); // full workflow, not a single -j job
		expect(act).toContain("--rm"); // teardown even on failure
		expect(act).toContain("--action-offline-mode"); // uses the pre-cached actions
		expect(ranShell("docker", "rm")).toBe(true); // reaped the two act containers
	});

	it("propagates act's non-zero exit (a red job fails ci:local)", () => {
		stubShell();
		stubAct({ present: true, runStatus: 1 });
		expect(ciLocal([])).toBe(1);
	});

	it("treats a missing act exit code as failure (act died without a code)", () => {
		stubShell();
		stubActNoExitCode();
		expect(ciLocal([])).toBe(1);
	});

	it("installs act via mise when it is not yet available", () => {
		stubShell();
		stubAct({ present: false, runStatus: 0 });
		ciLocal([]);
		expect(usedGlobalMiseInstall()).toBe(true); // global install, off the pinned project toolchain
	});

	it("pre-clones the actions into act's cache when absent (offline-mode)", () => {
		stubShell();
		stubAct();
		existsSyncMock.mockReturnValue(false); // cache empty → must clone
		ciLocal([]);
		const clones = gitCloneArgs();
		expect(clones.length).toBe(2); // actions/checkout + actions/cache
		// credential helper disabled so an ambient helper can't reject the public clone
		expect(clones.every((a) => a.includes("credential.helper="))).toBe(true);
	});
});

describe("ciLocal — --clean teardown", () => {
	it("removes containers, the runner image, and the action cache when Docker is up", () => {
		stubShell({ actContainers: "abc123" });
		stubAct();
		const code = ciLocal(["--clean"]);
		expect(code).toBe(0);
		expect(ranShell("docker", "rm")).toBe(true); // containers
		expect(ranShell("docker", "rmi")).toBe(true); // runner image
		expect(rmSyncMock).toHaveBeenCalled(); // action cache
		expect(actInvocation()).toBeUndefined(); // never runs the workflow
	});

	it("still drops the action cache when Docker is down (nothing to reap)", () => {
		stubShell({ dockerVersion: 1 });
		stubAct();
		const code = ciLocal(["--clean"]);
		expect(code).toBe(0);
		expect(rmSyncMock).toHaveBeenCalled();
		expect(ranShell("docker", "rmi")).toBe(false); // no image reap when daemon down
	});
});
