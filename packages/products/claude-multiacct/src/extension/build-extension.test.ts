/**
 * Intent: end-to-end proof that the extension bundler produces (a) a
 * manifest.json with MV3 shape, the right host match, and the right
 * version, and (b) a content.js that is a valid IIFE evaluating without
 * throwing in jsdom. Electron 42.5.1 / Chromium 148 (which Claude Desktop
 * 1.22209.3 ships) removed MV2 loading; if the manifest slips back to
 * MV2, session.defaultSession.loadExtension silently rejects and the
 * whole Code-tab feature is invisibly dead.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../index.ts";

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const script = resolve(pkgRoot, "scripts/build-extension.mjs");

describe("build-extension: dist/extension is a loadable unpacked extension", () => {
	it("emits manifest.json (MV3, claude.ai match, substituted version)", async () => {
		const result = spawnSync("node", [script], { cwd: pkgRoot, encoding: "utf8" });
		expect(result.status).toBe(0);
		const raw = await readFile(join(pkgRoot, "dist/extension/manifest.json"), "utf8");
		const manifest = JSON.parse(raw);
		expect(manifest.manifest_version).toBe(3);
		expect(manifest.version).toBe(PACKAGE_VERSION);
		expect(manifest.content_scripts[0].matches).toEqual(["https://claude.ai/*"]);
		expect(manifest.content_scripts[0].js).toEqual(["content.js"]);
		expect(manifest.content_scripts[0].run_at).toBe("document_idle");
	});

	it("declares bridge.json as a web-accessible resource for claude.ai (MV3 gate)", async () => {
		// Without this block, the content script's fetch(chrome.runtime.getURL("bridge.json"))
		// is silently blocked by MV3 -- the Code-tab feature loads but goes inert with no
		// visible error. MV2 exposed everything by default; MV3 requires this opt-in.
		spawnSync("node", [script], { cwd: pkgRoot, encoding: "utf8" });
		const raw = await readFile(join(pkgRoot, "dist/extension/manifest.json"), "utf8");
		const manifest = JSON.parse(raw);
		expect(Array.isArray(manifest.web_accessible_resources)).toBe(true);
		expect(manifest.web_accessible_resources).toHaveLength(1);
		expect(manifest.web_accessible_resources[0].resources).toEqual(["bridge.json"]);
		expect(manifest.web_accessible_resources[0].matches).toEqual(["https://claude.ai/*"]);
	});

	it("manifest validates against an MV3 schema (Chromium 148 rejects anything else)", async () => {
		spawnSync("node", [script], { cwd: pkgRoot, encoding: "utf8" });
		const raw = await readFile(join(pkgRoot, "dist/extension/manifest.json"), "utf8");
		const manifest = JSON.parse(raw);
		// Pin the version literal — that's the load-bearing bit. A regression
		// to MV2 (or a typo like MV4) throws here rather than silently
		// disabling the extension at runtime.
		const Mv3Manifest = v.object({
			manifest_version: v.literal(3),
			name: v.string(),
			version: v.string(),
			permissions: v.array(v.string()),
			content_scripts: v.array(
				v.object({
					matches: v.array(v.string()),
					js: v.array(v.string()),
					run_at: v.picklist(["document_start", "document_end", "document_idle"]),
				}),
			),
			web_accessible_resources: v.array(
				v.object({
					resources: v.array(v.string()),
					matches: v.array(v.string()),
				}),
			),
		});
		expect(() => v.parse(Mv3Manifest, manifest)).not.toThrow();
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
