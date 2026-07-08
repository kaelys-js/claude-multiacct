#!/usr/bin/env node
/**
 * Single format entrypoint: runs every formatter in the {@link TOOLS} registry.
 *   format.ts                  format the whole repo
 *   format.ts --check          verify formatting; non-zero if anything is unformatted
 *   format.ts --only <id>      restrict to one tool (used by per-tool turbo tasks)
 *   format.ts FILE...          format only these paths (lefthook passes staged files)
 *
 * @module
 */

import { parseArgs } from "./parse-args.ts";
import { run } from "./dispatch.ts";

const { check, only, files } = parseArgs(process.argv.slice(2));
const mode = check ? "format-check" : "format-write";
process.exit(run(mode, files.length > 0 ? files : null, only) ? 0 : 1);
