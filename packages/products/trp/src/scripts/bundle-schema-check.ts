#!/usr/bin/env node
/**
 * `bundle-schema-check.ts` — TS port of `trp/scripts/bundle-schema-check.py`
 * (SRP-X). Detects bundle code referencing Prisma models/fields that don't
 * exist in the client repo's `schema.prisma` at the pinned SHA.
 *
 * Prevents the class of workflow-agent hallucination where the design agent
 * invents a Prisma field (e.g. `InternalUser.entraOid`) that isn't in
 * `prisma/schema.prisma`.
 *
 * Ported byte-for-byte from the Python original: every regex, every branch,
 * every skip condition, every exit code is preserved. No feature additions.
 *
 * Env: `BUNDLE_JSON`, `FIX_SRC`, `TASK_ID_SLUG`.
 * Exit: 0 pass, 5 on any missing field reference.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type BundleEntry = {
	path: string;
	full_content?: string;
};

type Bundle = {
	files_to_modify: BundleEntry[];
};

type Finding = {
	kind: string;
	severity: string;
	file: string;
	summary: string;
	evidence: string;
};

// Recursive glob for `schema.prisma` files under `root`. Mirrors Python's
// `glob.glob(os.path.join(fix_src, '**', 'schema.prisma'), recursive=True)`.
function findSchemaFiles(root: string): string[] {
	const results: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st: ReturnType<typeof statSync> | undefined;
			try {
				st = statSync(full);
			} catch {
				st = undefined;
			}
			if (st !== undefined) {
				if (st.isDirectory()) {
					walk(full);
				} else if (name === "schema.prisma") {
					results.push(full);
				}
			}
		}
	};
	walk(root);
	return results;
}

export async function main(): Promise<number> {
	const bundlePath = process.env.BUNDLE_JSON;
	const fixSrc = process.env.FIX_SRC;
	const secLower = process.env.TASK_ID_SLUG;
	if (bundlePath === undefined || fixSrc === undefined || secLower === undefined) {
		throw new Error("BUNDLE_JSON, FIX_SRC, TASK_ID_SLUG must all be set");
	}

	// Read all Prisma schemas in the client repo.
	const schemaFiles = findSchemaFiles(fixSrc);
	if (schemaFiles.length === 0) {
		process.stdout.write("   no prisma schemas found — skipping SRP-X\n");
		return 0;
	}

	// Parse each schema for model definitions + field names.
	const models: Map<string, Set<string>> = new Map();
	const MODEL_HEADER = /^model\s+(\w+)\s*\{/gmu;
	const FIELD_LINE = /^\s*(\w+)\s+\w/u;
	for (const sf of schemaFiles) {
		const txt = readFileSync(sf, "utf8");
		// Split into blocks by model
		MODEL_HEADER.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = MODEL_HEADER.exec(txt)) !== null) {
			const [, modelName] = m as unknown as [string, string];
			// Find closing brace
			const start = m.index + m[0].length;
			let depth = 1;
			let i = start;
			while (i < txt.length && depth > 0) {
				if (txt[i] === "{") {
					depth += 1;
				} else if (txt[i] === "}") {
					depth -= 1;
				}
				i += 1;
			}
			const block = txt.slice(start, i - 1);
			const fields = new Set<string>();
			for (const line of block.split("\n")) {
				const fm = FIELD_LINE.exec(line);
				const trimmed = line.trim();
				if (fm && !trimmed.startsWith("@@") && !trimmed.startsWith("//")) {
					const [, fieldName] = fm as unknown as [string, string];
					fields.add(fieldName);
				}
			}
			if (!models.has(modelName)) {
				models.set(modelName, new Set());
			}
			const existing = models.get(modelName);
			if (existing === undefined) {
				throw new Error("unexpected undefined");
			}
			for (const f of fields) {
				existing.add(f);
			}
		}
	}

	if (models.size === 0) {
		process.stdout.write("   prisma schemas found but no models parsed — skipping SRP-X\n");
		return 0;
	}

	// Scan bundle file contents for `prisma.<lowercase-model>.<method>({ where: { <field>: ... } })`
	// and `<Model>.field` typed access.
	const b: Bundle = JSON.parse(await readFile(bundlePath, "utf8"));
	const findings: Finding[] = [];
	// Pattern: prisma.internalUser.something({ where: { entraOid: ... } })
	const PRISMA_ACCESS =
		/prisma\.(\w+)\.(?:findFirst|findUnique|findMany|create|update|delete|upsert|count)\s*\(\s*\{[^}]*?where\s*:\s*\{([^{}]+)\}/gsu;
	// Extract field: value pairs from the where clause
	const FIELD_KV = /(\w+)\s*:/gu;

	const RAW_SQL = /prisma\.\$(?:queryRaw|executeRaw)(?:Unsafe)?(?:`|\()([^`)]{5,500}?)(?:`|\))/gsu;
	// From raw SQL, pull table/column identifiers (best-effort — SQL parsing is heuristic).
	const SQL_IDENT = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE|SET)\s+"?(\w+)"?/giu;

	const PRISMA_KEYWORDS = new Set([
		"OR",
		"AND",
		"NOT",
		"in",
		"not",
		"equals",
		"contains",
		"startsWith",
		"endsWith",
		"mode",
		"lt",
		"lte",
		"gt",
		"gte",
	]);

	for (const entry of b.files_to_modify) {
		const content = entry.full_content ?? "";
		if (content) {
			// Raw SQL
			RAW_SQL.lastIndex = 0;
			let rm: RegExpExecArray | null;
			while ((rm = RAW_SQL.exec(content)) !== null) {
				const [, sql] = rm as unknown as [string, string];
				const sqlIdent = new RegExp(SQL_IDENT.source, SQL_IDENT.flags);
				let tm: RegExpExecArray | null;
				while ((tm = sqlIdent.exec(sql)) !== null) {
					const [, table] = tm as unknown as [string, string];
					// Prisma models use PascalCase; SQL often uses snake_case_plural — try both.
					// Match Python semantics exactly: `str.rstrip('s')` strips ALL trailing
					// `s` chars, and `str.capitalize()` uppercases the first char AND
					// lowercases the rest.
					const stripped = table.replace(/s+$/u, "");
					const pascal = stripped
						.split("_")
						.map((w) => {
							if (w.length > 0) {
								const [first] = w;
								if (first === undefined) {
									throw new Error("unexpected undefined");
								}
								return first.toUpperCase() + w.slice(1).toLowerCase();
							}
							return w;
						})
						.join("");
					if (!models.has(table) && !models.has(pascal) && !models.has(stripped)) {
						findings.push({
							kind: "raw-sql-unknown-table",
							severity: "medium",
							file: entry.path,
							summary: `raw SQL references table \`${table}\` — no matching Prisma model`,
							evidence: sql.slice(0, 150),
						});
					}
				}
			}
			PRISMA_ACCESS.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = PRISMA_ACCESS.exec(content)) !== null) {
				const [, modelLower, whereBody] = m as unknown as [string, string, string];
				// Map lowercase model name to actual model (Prisma convention).
				const [firstChar] = modelLower;
				if (firstChar === undefined) {
					throw new Error("unexpected undefined");
				}
				const modelPascal = firstChar.toUpperCase() + modelLower.slice(1);
				const knownFields = models.get(modelPascal);
				if (knownFields === undefined) {
					findings.push({
						kind: "missing-prisma-model",
						severity: "high",
						file: entry.path,
						summary: `prisma.${modelLower} referenced but no model \`${modelPascal}\` in any schema.prisma`,
						evidence: m[0].slice(0, 150),
					});
				} else {
					const fieldKv = new RegExp(FIELD_KV.source, FIELD_KV.flags);
					let fm: RegExpExecArray | null;
					while ((fm = fieldKv.exec(whereBody)) !== null) {
						const [, fname] = fm as unknown as [string, string];
						// Prisma keywords / operators — skip
						if (!PRISMA_KEYWORDS.has(fname) && !knownFields.has(fname)) {
							findings.push({
								kind: "missing-prisma-field",
								severity: "high",
								file: entry.path,
								summary: `${modelPascal}.${fname} referenced but not declared in schema.prisma`,
								evidence: m[0].slice(0, 150),
							});
						}
					}
				}
			}
		}
	}

	if (findings.length === 0) {
		process.stdout.write(`   SRP-X prisma check: PASS (${models.size} models scanned)\n`);
		return 0;
	}

	const report = `discovery/bundle-schema-${secLower}.json`;
	writeFileSync(
		report,
		`${JSON.stringify({ findings, models_scanned: [...models.keys()] }, null, 2)}\n`,
	);
	process.stdout.write(`   SRP-X prisma check: ${findings.length} finding(s) → ${report}\n`);
	for (const f of findings) {
		process.stdout.write(`     [${f.severity.toUpperCase()}] ${f.file}: ${f.summary}\n`);
	}
	return 5;
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
	try {
		const code = await main();
		process.exit(code);
	} catch (error: unknown) {
		process.stderr.write(
			`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exit(1);
	}
}
