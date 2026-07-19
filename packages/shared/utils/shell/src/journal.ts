/**
 * `@foundation/shell` — stdout/stderr journal.
 *
 * A `Journal` is a pair of writable sinks that `sh()` streams the child's
 * stdout and stderr through, in addition to capturing them into memory for
 * the returned result. This is the file-plus-stream shape TRP's driver needs:
 * the fix-task log tails in real time while the final `ShResult` still carries
 * the captured strings for failure-JSON emission.
 *
 * `nullJournal()` is the default: discard sinks. `stdioJournal()` fans to
 * process.stdout/stderr with an optional line prefix (for interleaved
 * multi-command runs). Callers can supply any writable pair for tests or
 * bespoke log routing.
 *
 * @module
 */

import { Writable } from "node:stream";

export type Journal = {
	readonly out: NodeJS.WritableStream;
	readonly err: NodeJS.WritableStream;
};

// Discard sink for nullJournal. Hoisted out of the factory so we don't
// allocate a new closure on every nullJournal() call; the stream object
// itself is per-call since Writable instances buffer state per consumer.
const makeSink = (): Writable =>
	new Writable({
		write(_chunk, _enc, cb): void {
			cb();
		},
	});

// A journal that discards everything. Used when the caller only needs the
// captured strings on the returned result.
export function nullJournal(): Journal {
	return { out: makeSink(), err: makeSink() };
}

export type StdioJournalOptions = {
	// Optional prefix written before every chunk (e.g. "[fix-task] ").
	// Empty string disables the prefix.
	readonly prefix?: string;
};

// A journal that mirrors to process.stdout/stderr, prefixing each chunk when
// `prefix` is set. `sh()` calls this journal's write on every data event, so
// the child's output stays visible while it also gets captured.
export function stdioJournal(opts: StdioJournalOptions = {}): Journal {
	const prefix = opts.prefix ?? "";
	const wrap = (target: NodeJS.WriteStream): Writable =>
		new Writable({
			write(chunk, _enc, cb): void {
				const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
				target.write(prefix ? `${prefix}${text}` : text);
				cb();
			},
		});
	return { out: wrap(process.stdout), err: wrap(process.stderr) };
}
