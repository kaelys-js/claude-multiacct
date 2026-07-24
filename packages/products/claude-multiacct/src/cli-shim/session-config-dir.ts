/**
 * `@foundation/claude-multiacct` — per-session identity view of the config dir.
 *
 * Token-only swapping changes billing, rate-limit and identity on the wire, but
 * the account the MODEL self-reports is read from `oauthAccount` in the config
 * dir's `.claude.json` (the shared `~/.claude.json` when `CLAUDE_CONFIG_DIR` is
 * unset). So a token-only swap leaves every swapped session reporting the
 * PRIMARY account. A fresh, empty per-account config dir fixes the self-report
 * but forks the transcript into a private tree and makes the binary report
 * "unknown" until it re-fetches a profile.
 *
 * This module builds the middle path proven against Claude Code 2.1.217: a
 * per-account dir whose `.claude.json` is a copy of the shared one with only
 * `oauthAccount` overridden to the chosen account, and whose transcript/session
 * stores are symlinked back to the shared `~/.claude/<sub>`. The model reports
 * the swapped account; the transcript still lands in — and resumes append to —
 * the one shared `~/.claude/projects/<cwd>/<uuid>.jsonl`. Parent and child share
 * the same `CLAUDE_CONFIG_DIR`, so no transcript-mirror mismatch is ever raised.
 *
 * The native (primary) account reads the shared config directly: `buildSession-
 * ConfigDir` returns `undefined` for it, which leaves `CLAUDE_CONFIG_DIR` unset
 * and is exactly the launcher's default behaviour.
 *
 * Everything is fail-soft. The token is the load-bearing half of the swap; if
 * the shared `.claude.json` is missing or corrupt we still write a minimal
 * identity file and proceed, and a store whose shared target does not exist is
 * skipped rather than fabricated. All soft failures go to the injected `warn`.
 *
 * @module
 */

import {
	lstat as fsLstat,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	readlink as fsReadlink,
	rename as fsRename,
	rm as fsRm,
	symlink as fsSymlink,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Account, effectiveSource } from "../domain/account.ts";
import { defaultRoot } from "../oauth/file-token-store.ts";

/**
 * The session/transcript stores symlinked back to the shared `~/.claude`. These
 * are the directories Claude Code writes conversation state into; sharing them
 * (rather than copying) is what keeps a swapped session's transcript in the same
 * place a `--resume` under the primary account would find it.
 */
const SHARED_STORES = [
	"projects",
	"sessions",
	"todos",
	"shell-snapshots",
	"statsig",
	"session-env",
] as const;

/**
 * Narrow filesystem port. Bound to `node:fs/promises` at runtime; tests pass
 * wrappers so they can count `symlink`/`rm` calls (idempotency proof) while
 * still exercising real symlink semantics on a temp dir.
 */
export type SessionConfigFs = {
	mkdir: (path: string, opts: { recursive: true; mode?: number }) => Promise<unknown>;
	readFile: (path: string, encoding: "utf8") => Promise<string>;
	writeFile: (path: string, data: string, opts: { mode?: number }) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	symlink: (target: string, path: string) => Promise<void>;
	lstat: (path: string) => Promise<{ isSymbolicLink: () => boolean }>;
	readlink: (path: string) => Promise<string>;
	rm: (path: string, opts: { recursive: true; force: true }) => Promise<void>;
};

/** Injected surface for {@link buildSessionConfigDir}. */
export type SessionConfigDirDeps = {
	/** Parent of `account-config/`. Default: {@link defaultRoot}. */
	rootDir: string;
	/** Shared Claude state dir the stores link back to. Default `~/.claude`. */
	sharedClaudeDir: string;
	/** Shared config file copied for the identity override. Default `~/.claude.json`. */
	sharedConfigPath: string;
	/** Soft-failure sink. Runtime binds stderr; tests inject a spy. */
	warn: (message: string) => void;
	fs: SessionConfigFs;
};

/**
 * Real dependencies: `node:fs/promises` bindings and the real home-derived
 * paths. Exported so the shim entry (and tests) can build from one place.
 *
 * @returns {SessionConfigDirDeps} Deps wired to the real filesystem.
 */
export function realSessionConfigDeps(): SessionConfigDirDeps {
	return {
		rootDir: defaultRoot(),
		sharedClaudeDir: join(homedir(), ".claude"),
		sharedConfigPath: join(homedir(), ".claude.json"),
		warn: (message: string) => {
			process.stderr.write(`[cma-shim] ${message}\n`);
		},
		fs: {
			mkdir: fsMkdir,
			readFile: fsReadFile,
			writeFile: fsWriteFile,
			rename: fsRename,
			symlink: fsSymlink,
			lstat: fsLstat,
			readlink: fsReadlink,
			rm: fsRm,
		},
	};
}

/**
 * Build (or refresh) the per-session identity view for `account` and return its
 * absolute path, or `undefined` for the native account (which reads the shared
 * config directly — no dir, no writes).
 *
 * The dir is idempotent: re-running for the same account overwrites the identity
 * `.claude.json`, leaves an already-correct store symlink untouched, and repairs
 * a wrong or stale entry in place.
 *
 * @param {Account} account - The resolved pool account being swapped in.
 * @param {SessionConfigDirDeps} deps - Injected fs port, paths, and warn sink.
 * @returns {Promise<string | undefined>} The dir path, or `undefined` for native.
 */
export async function buildSessionConfigDir(
	account: Account,
	deps: SessionConfigDirDeps = realSessionConfigDeps(),
): Promise<string | undefined> {
	if (effectiveSource(account) === "native") {
		return undefined;
	}

	const dir = join(deps.rootDir, "account-config", account.uuid);
	await deps.fs.mkdir(dir, { recursive: true, mode: 0o700 });

	await writeIdentityConfig(account, dir, deps);
	await linkSharedStores(dir, deps);

	return dir;
}

/**
 * Write `<dir>/.claude.json` as the shared config with `oauthAccount` overridden
 * to this account's identity. A missing or corrupt shared file falls back to a
 * minimal `{ oauthAccount }` so the swap still proceeds. Atomic via tmp+rename.
 *
 * @param {Account} account - The account whose identity is written.
 * @param {string} dir - The per-account config dir.
 * @param {SessionConfigDirDeps} deps - Injected fs port and warn sink.
 * @returns {Promise<void>}
 */
async function writeIdentityConfig(
	account: Account,
	dir: string,
	deps: SessionConfigDirDeps,
): Promise<void> {
	let base: Record<string, unknown> = {};
	try {
		const raw = await deps.fs.readFile(deps.sharedConfigPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			base = parsed as Record<string, unknown>;
		}
	} catch (error) {
		deps.warn(
			`cma-shim: shared ${deps.sharedConfigPath} unreadable (${String(error)}); writing a minimal identity config`,
		);
	}

	const existingOauth =
		typeof base.oauthAccount === "object" && base.oauthAccount !== null
			? (base.oauthAccount as Record<string, unknown>)
			: {};
	const oauthAccount: Record<string, unknown> = { ...existingOauth };
	if (account.accountUuid !== undefined) {
		oauthAccount.accountUuid = account.accountUuid;
	}
	if (account.identity?.email !== undefined) {
		oauthAccount.emailAddress = account.identity.email;
	}

	const merged = { ...base, oauthAccount };
	const finalPath = join(dir, ".claude.json");
	const tmpPath = `${finalPath}.tmp.${String(process.pid)}.${String(Date.now())}`;
	await deps.fs.writeFile(tmpPath, JSON.stringify(merged), { mode: 0o600 });
	await deps.fs.rename(tmpPath, finalPath);
}

/**
 * Ensure each shared store under `dir` is a symlink to `<sharedClaudeDir>/<sub>`.
 * Skips a store whose shared target is absent (nothing to link to yet), leaves
 * an already-correct link untouched, and replaces a wrong entry.
 *
 * @param {string} dir - The per-account config dir.
 * @param {SessionConfigDirDeps} deps - Injected fs port and paths.
 * @returns {Promise<void>}
 */
async function linkSharedStores(dir: string, deps: SessionConfigDirDeps): Promise<void> {
	for (const sub of SHARED_STORES) {
		const target = join(deps.sharedClaudeDir, sub);
		const link = join(dir, sub);
		// eslint-disable-next-line no-await-in-loop -- serial: each link is independent and cheap; parallelism buys nothing here.
		await ensureSymlink(target, link, deps);
	}
}

/**
 * Idempotently point `link` at `target`. No-op when the shared `target` does not
 * exist, or when `link` is already the correct symlink. Any other entry at
 * `link` is removed and re-created.
 *
 * @param {string} target - Shared store the link should resolve to.
 * @param {string} link - Path inside the per-account dir.
 * @param {SessionConfigDirDeps} deps - Injected fs port.
 * @returns {Promise<void>}
 */
async function ensureSymlink(
	target: string,
	link: string,
	deps: SessionConfigDirDeps,
): Promise<void> {
	try {
		await deps.fs.lstat(target);
	} catch {
		// Shared target not created yet; fabricating a dangling link would only
		// confuse the CLI. Skip — a later run links it once the store exists.
		return;
	}

	try {
		const stat = await deps.fs.lstat(link);
		if (stat.isSymbolicLink() && (await deps.fs.readlink(link)) === target) {
			return;
		}
		await deps.fs.rm(link, { recursive: true, force: true });
	} catch {
		// No entry at `link` yet — fall through to create it.
	}

	await deps.fs.symlink(target, link);
}
