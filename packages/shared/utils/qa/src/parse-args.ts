/**
 * Argv parsing shared by the {@link ./lint.ts} and {@link ./format.ts}
 * entrypoints. Recognises `--check` (format only) and `--only <id>`; everything
 * else is treated as a staged file path passed through by lefthook.
 *
 * @module
 */

/** The recognised flags plus the residual positional file list. */
export type ParsedArgs = {
	/** Whether `--check` was present (format check mode). */
	readonly check: boolean;
	/** The single tool id from `--only <id>`, or `null` for all tools. */
	readonly only: string | null;
	/** The residual positional arguments (staged file paths). */
	readonly files: string[];
};

// Parse a QA-runner argv into flags and residual file paths.
export function parseArgs(argv: readonly string[]): ParsedArgs {
	let check = false;
	let only: string | null = null;
	const files: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--check") {
			check = true;
		} else if (arg === "--only") {
			i += 1;
			only = argv[i] ?? null;
		} else if (arg !== undefined) {
			files.push(arg);
		}
	}
	return { check, only, files };
}
