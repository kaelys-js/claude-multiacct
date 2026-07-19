/**
 * `@foundation/shell` — shell primitives promoted from the strach-poc and TRP
 * scripts. execa-backed command runner with pipefail-equivalent semantics,
 * enforced timeouts, closed stdin, structured errors, and a journal for
 * streaming child output.
 *
 * @module
 */

export { sh, type ShOptions, type ShResult } from "./run.ts";
export { ShError, isShError, fromExecaError, type ShErrorInit } from "./error.ts";
export { type Journal, type StdioJournalOptions, nullJournal, stdioJournal } from "./journal.ts";
