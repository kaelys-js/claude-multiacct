// Toolchain drift guard — asserts the pinned Node and pnpm versions are
// identical across every place they are declared, so the mise toolchain, the
// package manifest, and the .nvmrc can never silently diverge.
//
// Node version sources (must all match):
//   .nvmrc                      — single-line version
//   package.json engines.node   — exact pin
//   mise.toml [tools].node       — exact pin
//
// pnpm version sources (must all match):
//   package.json engines.pnpm       — exact pin
//   package.json packageManager      — "pnpm@X"
//   mise.toml [tools].pnpm            — exact pin
//
// Pure + deterministic: reads files, no network, no model calls. Erasable TS
// syntax only (no enums/namespaces/param-properties) so Node 26 runs it
// natively and `tsc --noEmit` type-checks it under the strict tsconfig.
//
// Exit 0 when everything is aligned; exit 1 (naming each mismatch) otherwise;
// exit 2 on an operational fault (a source file is missing/unreadable/malformed).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv, exit, stderr, stdout } from "node:process";

// One declared version and where it came from, for precise mismatch messages.
interface Source {
  label: string;
  value: string;
}

function fail(message: string): never {
  stderr.write(`check-toolchain-sync: ${message}\n`);
  exit(2);
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return fail(`cannot read ${path}: ${detail}`);
  }
}

// Extract `node = "X"` / `pnpm = "X"` from the [tools] table of mise.toml with a
// targeted line scan (no TOML dep). We only trust the entry once we are inside
// the [tools] table so a same-named key in another table can't be picked up.
function miseToolVersion(toml: string, tool: string): string {
  let inTools = false;
  const tableHeader = /^\s*\[([^\]]+)\]\s*$/;
  const entry = new RegExp(`^\\s*${tool}\\s*=\\s*"([^"]+)"`);
  for (const line of toml.split("\n")) {
    const header = tableHeader.exec(line);
    if (header !== null) {
      inTools = header[1]?.trim() === "tools";
      continue;
    }
    if (!inTools) continue;
    const m = entry.exec(line);
    if (m !== null && m[1] !== undefined) {
      return m[1];
    }
  }
  return fail(`mise.toml has no [tools].${tool} entry`);
}

// Minimal typed view of the package.json fields we read.
interface PkgManifest {
  engines?: { node?: unknown; pnpm?: unknown };
  packageManager?: unknown;
}

function parsePackageJson(text: string): PkgManifest {
  try {
    return JSON.parse(text) as PkgManifest;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return fail(`package.json is not valid JSON: ${detail}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${label} is missing or not a string`);
  }
  return value;
}

// packageManager is "pnpm@11.10.0" — pull the version after the '@'.
function packageManagerVersion(pm: string): string {
  const m = /^pnpm@(.+)$/.exec(pm);
  if (m === null || m[1] === undefined) {
    return fail(`packageManager '${pm}' is not of the form 'pnpm@<version>'`);
  }
  return m[1];
}

// Assert every source shares one value; push a per-mismatch message otherwise.
function checkGroup(name: string, sources: Source[], mismatches: string[]): void {
  const first = sources[0];
  if (first === undefined) return;
  const expected = first.value;
  const offenders = sources.filter((s) => s.value !== expected);
  if (offenders.length === 0) return;
  const shown = sources.map((s) => `${s.label}=${s.value}`).join(", ");
  mismatches.push(`${name} version drift: ${shown}`);
}

function main(): number {
  const nvmrc = read(".nvmrc").trim();
  const miseToml = read("mise.toml");
  const pkg = parsePackageJson(read("package.json"));

  const enginesNode = requireString(pkg.engines?.node, "package.json engines.node");
  const enginesPnpm = requireString(pkg.engines?.pnpm, "package.json engines.pnpm");
  const packageManager = requireString(pkg.packageManager, "package.json packageManager");

  const nodeSources: Source[] = [
    { label: ".nvmrc", value: nvmrc },
    { label: "package.json engines.node", value: enginesNode },
    { label: "mise.toml [tools].node", value: miseToolVersion(miseToml, "node") },
  ];
  const pnpmSources: Source[] = [
    { label: "package.json engines.pnpm", value: enginesPnpm },
    { label: "package.json packageManager", value: packageManagerVersion(packageManager) },
    { label: "mise.toml [tools].pnpm", value: miseToolVersion(miseToml, "pnpm") },
  ];

  const mismatches: string[] = [];
  checkGroup("node", nodeSources, mismatches);
  checkGroup("pnpm", pnpmSources, mismatches);

  if (mismatches.length > 0) {
    for (const m of mismatches) {
      stderr.write(`check-toolchain-sync: ${m}\n`);
    }
    return 1;
  }

  const nodeFirst = nodeSources[0];
  const pnpmFirst = pnpmSources[0];
  const nodeVersion = nodeFirst !== undefined ? nodeFirst.value : "?";
  const pnpmVersion = pnpmFirst !== undefined ? pnpmFirst.value : "?";
  stdout.write(`toolchain in sync — node ${nodeVersion}, pnpm ${pnpmVersion}\n`);
  return 0;
}

const isMain = (() => {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  exit(main());
}
