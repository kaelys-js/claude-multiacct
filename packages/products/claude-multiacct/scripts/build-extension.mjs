/**
 * `@foundation/claude-multiacct` — extension bundler.
 *
 * Produces `dist/extension/content.js` (IIFE bundle of `src/extension/content.ts`)
 * and `dist/extension/manifest.json` (the template with `__VERSION__` substituted).
 * Kept parallel with the other build-* scripts: entry lives in src, but no
 * shebang goes on the output (content scripts can't have one).
 *
 * @module
 */

import esbuild from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const entry = resolve(pkgRoot, "src/extension/content.ts");
const outfile = resolve(pkgRoot, "dist/extension/content.js");
const manifestSrc = resolve(pkgRoot, "src/extension/manifest.tmpl.json");
const manifestOut = resolve(pkgRoot, "dist/extension/manifest.json");
const pkgJson = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));

mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	sourcemap: "inline",
	minify: false,
	logLevel: "warning",
});

const template = readFileSync(manifestSrc, "utf8");
const materialized = template.replaceAll("__VERSION__", pkgJson.version);
// Round-trip through JSON.parse to fail loud if the substitution corrupted the shape.
JSON.parse(materialized);
writeFileSync(manifestOut, materialized);
