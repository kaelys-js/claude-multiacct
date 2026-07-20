/**
 * Intent: end-to-end proof that the extension bundler produces (a) a
 * manifest.json with MV2 shape, the right host match, and the right
 * version, and (b) a content.js that is a valid IIFE evaluating without
 * throwing in jsdom. If the bundler slips into ESM or forgets the version
 * substitution, the RDT-anchor loader silently refuses to load the
 * extension and the whole Code-tab feature is invisibly dead.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../index.ts";

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const script = resolve(pkgRoot, "scripts/build-extension.mjs");

describe("build-extension: dist/extension is a loadable unpacked extension", () => {
	it("emits manifest.json (MV2, claude.ai match, substituted version)", async () => {
		const result = spawnSync("node", [script], { cwd: pkgRoot, encoding: "utf8" });
		expect(result.status).toBe(0);
		const raw = await readFile(join(pkgRoot, "dist/extension/manifest.json"), "utf8");
		const manifest = JSON.parse(raw);
		expect(manifest.manifest_version).toBe(2);
		expect(manifest.version).toBe(PACKAGE_VERSION);
		expect(manifest.content_scripts[0].matches).toEqual(["https://claude.ai/*"]);
		expect(manifest.content_scripts[0].js).toEqual(["content.js"]);
	});

	it("emits content.js as an IIFE that evaluates in jsdom without throwing", async () => {
		spawnSync("node", [script], { cwd: pkgRoot, encoding: "utf8" });
		const src = await readFile(join(pkgRoot, "dist/extension/content.js"), "utf8");
		// esbuild IIFE opener is one of: (()=>{ ... })(); or var x=(()=>{ ... })();
		// esbuild IIFE emits `"use strict";\n(() => { ... })();` optionally
		// preceded by a `var name = ` binding — allow either shape.
		expect(src).toMatch(/^(?:"use strict";\s*)?(?:var\s+\w+\s*=\s*)?\(\s*\(\s*\)\s*=>\s*\{/u);
		// No shebang — content scripts can't have one.
		expect(src.startsWith("#!")).toBe(false);
		const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
			url: "https://claude.ai/chat",
			runScripts: "outside-only",
		});
		let threw: unknown;
		try {
			dom.window.eval(src);
		} catch (error) {
			threw = error;
		}
		expect(threw).toBeUndefined();
	});
});
