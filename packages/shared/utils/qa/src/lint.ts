#!/usr/bin/env node
/**
 * Single lint entrypoint: runs every linter in the {@link TOOLS} registry.
 * With file arguments (lefthook passes staged files) it lints only those;
 * with none it lints the whole repo. `--only <id>` restricts the run to one
 * tool (used by the per-tool turbo tasks). Exits non-zero if any linter failed.
 *
 * @module
 */

import { parseArgs } from "./parse-args.ts";
import { run } from "./dispatch.ts";

const { only, files } = parseArgs(process.argv.slice(2));
process.exit(run("lint", files.length > 0 ? files : null, only) ? 0 : 1);
