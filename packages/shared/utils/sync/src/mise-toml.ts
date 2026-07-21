/**
 * Parse tool pins out of `mise.toml`'s `[tools]` table. Shared by the sync
 * scripts (`versions.ts` reads node/pnpm; `schemas.ts` reads the versioned schema
 * tools).
 *
 * @module
 */

// RegExp metacharacters that must be escaped when a tool name is embedded in a
// pattern, so a pin like `npm:oxlint` (containing `.`/`:`) matches literally.
const REGEX_META = /[.*+?^${}()|[\]\\]/gu;

// Read a tool's pinned version from the `[tools]` table of `mise.toml`. Only the
// `[tools]` section is scanned, so an identically-named key elsewhere (e.g. under
// `[env]`) can't be mistaken for a tool pin. Throws if the tool is absent.
export function readToolVersion(toml: string, tool: string): string {
	const lines = toml.split("\n");
	let inTools = false;
	for (const line of lines) {
		const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
		if (header) {
			inTools = header[1] === "tools";
		} else if (inTools) {
			const escaped = tool.replaceAll(REGEX_META, String.raw`\$&`);
			const match = new RegExp(String.raw`^\s*"?${escaped}"?\s*=\s*"([^"]+)"`, "u").exec(line);
			if (match?.[1] !== undefined) {
				return match[1];
			}
		}
	}
	throw new Error(`mise.toml: no [tools] entry for "${tool}"`);
}
