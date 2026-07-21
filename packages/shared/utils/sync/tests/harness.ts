// Shared in-process harness for the sync scripts (`packages/shared/utils/sync/src/*.ts`).
//
// versions.ts / turbo.ts / auto.ts run ALL their work at module top-level
// (top-level `process.exit`, `writeFileSync`, `spawnSync`) rather than exporting
// functions, and they resolve their target paths from `import.meta.dirname`
// (i.e. the REAL repo). To exercise them under v8 coverage they must execute
// INSIDE the vitest worker — a spawned subprocess is not instrumented and would
// contribute zero coverage. So each test imports the real module (giving true
// in-process coverage) while this harness intercepts the module's IO:
//
//   - `node:fs` reads/writes are routed to an in-memory file map keyed by path
//     SUFFIX (`mise.toml`, `.nvmrc`, …), so a fixture controls what the script
//     sees and observes what it writes, without touching the real repo.
//   - `process.argv` / `process.exit` / `stdout` / `stderr` are stubbed so a
//     `--check` exit and the printed report are assertable, not fatal.
//
// This is real behaviour: the script's own parsing, diffing, and write logic run
// unmodified — only the filesystem boundary and the process globals are faked.

import { vi } from "vitest";

export type FsCall = { readonly path: string; readonly data: string };

// The shape the sync scripts invoke `spawnSync` with: a command, an argv array,
// and an options bag carrying the piped `input`. A test double returns a
// spawn-result-like object (only `status`/`stdout`/`stderr` are read).
export type SpawnStub = (
	command?: unknown,
	args?: unknown,
	options?: { readonly input?: string },
) => unknown;

export type HarnessResult = {
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly writes: FsCall[];
	readonly files: Map<string, string>;
};

export type HarnessOptions = {
	// suffix→content map the mocked fs serves for reads and mutates on writes.
	readonly files: Map<string, string>;
	// argv AFTER `node <entry>` (e.g. `["--check"]`).
	readonly argv?: readonly string[];
	// The value placed at `process.argv[1]`. schemas.ts / validate-records.ts gate
	// their `main()` on `import.meta.filename === process.argv[1]`; set this to that
	// module's absolute filename to trigger the CLI path in-process.
	readonly entry?: string;
	// extra `node:child_process.spawnSync` stub; defaults to a success no-op.
	readonly spawnSync?: SpawnStub;
};

// A sentinel thrown by the stubbed `process.exit` so top-level `process.exit(n)`
// unwinds the module evaluation instead of killing the worker; the harness
// swallows it and records the code.
const EXIT_MARK = "__harness_exit__";

// Run one sync module in-process against an in-memory fixture. Returns the exit
// code (undefined if the module never called exit), captured stdout/stderr, and
// the list of writes plus the final file map.
export async function runScript(modulePath: string, opts: HarnessOptions): Promise<HarnessResult> {
	const { files } = opts;
	const argv = opts.argv ?? [];
	const writes: FsCall[] = [];
	const stdout: string[] = [];
	const stderr: string[] = [];
	let exitCode: number | undefined;

	// Match a requested path to a fixture key by suffix so absolute repo paths
	// (from `import.meta.dirname`) resolve to the fixture's short keys.
	// Return the LONGEST matching key, so multiple files with the same basename
	// (e.g. root `package.json` and `packages/x/package.json`) resolve distinctly —
	// a bare `package.json` key won't shadow a longer, more-specific one.
	const keyFor = (p: string): string | undefined => {
		let best: string | undefined;
		for (const k of files.keys()) {
			const matches = p === k || p.endsWith(`/${k}`) || p.endsWith(k);
			if (matches && (best === undefined || k.length > best.length)) {
				best = k;
			}
		}
		return best;
	};

	const spawnSync =
		opts.spawnSync ??
		((..._args: unknown[]): { status: number; stdout: string; stderr: string; signal: null } => ({
			status: 0,
			stdout: "",
			stderr: "",
			signal: null,
		}));

	vi.resetModules();

	vi.doMock("node:fs", () => ({
		readFileSync: (p: string): string => {
			const k = keyFor(String(p));
			if (k === undefined) {
				throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: "ENOENT" });
			}
			return files.get(k) ?? "";
		},
		writeFileSync: (p: string, data: string): void => {
			const path = String(p);
			writes.push({ path, data: String(data) });
			// Store under the existing fixture key if one matches; otherwise register a
			// key by BASENAME so a test can read a newly-created file back by its short
			// name (e.g. a first-run `.sync-hash` marker that had no prior fixture entry).
			const base = path.slice(path.lastIndexOf("/") + 1);
			files.set(keyFor(path) ?? base, String(data));
		},
		existsSync: (p: string): boolean => keyFor(String(p)) !== undefined,
		mkdirSync: (): void => undefined,
	}));

	vi.doMock("node:child_process", () => ({ spawnSync }));

	// The sync scripts now resolve the repo root and run tools via @foundation/core.
	// Mock it so `repoRoot` is a fixed path (fs matches by suffix, so the value is
	// irrelevant) and `miseExec` routes through the injected `spawnSync`, so the
	// existing oxfmt stubs still drive the formatter deterministically.
	vi.doMock("@foundation/core", () => ({
		repoRoot: (): string => "/repo",
		miseExec: (args: readonly string[], options?: Record<string, unknown>): unknown =>
			spawnSync("/repo/bin/mise", ["exec", "--", ...args], {
				cwd: "/repo",
				encoding: "utf8",
				...options,
			}),
	}));

	const fakeProcess = {
		...process,
		argv: ["node", opts.entry ?? "script.js", ...argv],
		exit: (code?: number): never => {
			exitCode = code;
			throw new Error(EXIT_MARK);
		},
	};
	vi.stubGlobal("process", fakeProcess);

	const proc = process as unknown as {
		stdout: { write: (s: string) => boolean };
		stderr: { write: (s: string) => boolean };
	};
	vi.spyOn(proc.stdout, "write").mockImplementation((s: string): boolean => {
		stdout.push(s);
		return true;
	});
	vi.spyOn(proc.stderr, "write").mockImplementation((s: string): boolean => {
		stderr.push(s);
		return true;
	});

	try {
		await import(modulePath);
	} catch (error) {
		if (!String(error).includes(EXIT_MARK)) {
			throw error;
		}
	}

	return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), writes, files };
}

// Restore all mocks/stubs after a test. Call from `afterEach`.
export function resetHarness(): void {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.doUnmock("node:fs");
	vi.doUnmock("node:child_process");
	vi.doUnmock("@foundation/core");
}
