// Behavior tests for `@foundation/shell`'s Journal.
//
// WHY it matters: the journal is what makes the fix-task log tail during a
// run. If nullJournal ever wrote through, tests that read stdout would
// double-count. If stdioJournal ever dropped the prefix or the chunk, an
// interleaved multi-command run would be unreadable.

import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { nullJournal, stdioJournal } from "../src/journal.ts";

function capture(): { stream: Writable; written: string[] } {
	const written: string[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb): void {
			written.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
			cb();
		},
	});
	return { stream, written };
}

describe("nullJournal", () => {
	it("accepts writes silently and never propagates them", async () => {
		const j = nullJournal();
		const outCb = vi.fn<() => void>();
		const errCb = vi.fn<() => void>();
		j.out.write(Buffer.from("stdout chunk"), outCb);
		j.err.write(Buffer.from("stderr chunk"), errCb);
		// Node's Writable invokes user-supplied write callbacks asynchronously
		// (via process.nextTick), even when the underlying _write calls its cb
		// synchronously. Wait a tick before asserting.
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		expect(outCb).toHaveBeenCalledTimes(1);
		expect(errCb).toHaveBeenCalledTimes(1);
	});
});

describe("stdioJournal", () => {
	it("forwards raw chunks to process.stdout/stderr when no prefix is set", () => {
		const outWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const errWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const j = stdioJournal();
			j.out.write(Buffer.from("one\n"));
			j.err.write(Buffer.from("two\n"));
			expect(outWrite).toHaveBeenCalledWith("one\n");
			expect(errWrite).toHaveBeenCalledWith("two\n");
		} finally {
			outWrite.mockRestore();
			errWrite.mockRestore();
		}
	});

	it("prepends the prefix to every chunk when set", () => {
		const outWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const errWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const j = stdioJournal({ prefix: "[tag] " });
			j.out.write(Buffer.from("a\n"));
			j.err.write(Buffer.from("b\n"));
			expect(outWrite).toHaveBeenCalledWith("[tag] a\n");
			expect(errWrite).toHaveBeenCalledWith("[tag] b\n");
		} finally {
			outWrite.mockRestore();
			errWrite.mockRestore();
		}
	});

	it("accepts string writes as well as buffers", () => {
		const outWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			const j = stdioJournal({ prefix: "P:" });
			j.out.write("hello");
			expect(outWrite).toHaveBeenCalledWith("P:hello");
		} finally {
			outWrite.mockRestore();
		}
	});

	it("lets callers supply arbitrary writable sinks via the Journal interface", () => {
		const outCap = capture();
		const errCap = capture();
		const j = { out: outCap.stream, err: errCap.stream };
		j.out.write(Buffer.from("x"));
		j.err.write(Buffer.from("y"));
		expect(outCap.written.join("")).toBe("x");
		expect(errCap.written.join("")).toBe("y");
	});

	// The Buffer.isBuffer(chunk) ternary has two branches: buffer-in and
	// string-in. Node's Writable coerces string writes to Buffer via
	// decodeStrings:true (default) before invoking _write, so ordinary
	// `.write("foo")` calls always land in the buffer branch. The string
	// branch fires only when a caller drives _write directly (or wraps the
	// stream with decodeStrings:false). Invoking _write on the wrapping
	// Writable is the deterministic way to prove String(chunk) still
	// prefixes and forwards the right text — without it, a regression that
	// drops the String() call would go uncaught by the existing
	// `.write("hello")` test above (which happens to also work with the
	// buffer branch because Buffer#toString("utf8") matches String() output
	// for the same bytes).
	it("stringifies non-Buffer chunks passed straight into _write", () => {
		const outWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			const j = stdioJournal({ prefix: "S:" });
			// Reach into _write on the wrapping Writable; Node's public write()
			// path always converts strings to Buffer before this point, so this
			// is the only way to exercise the non-Buffer path in the ternary.
			// oxlint-disable-next-line no-underscore-dangle -- Node stream internal
			(j.out as unknown as { _write: (c: unknown, e: string, cb: () => void) => void })._write(
				"raw-string",
				"utf8",
				() => {
					/* no-op */
				},
			);
			expect(outWrite).toHaveBeenCalledWith("S:raw-string");
		} finally {
			outWrite.mockRestore();
		}
	});

	it("stringifies non-Buffer chunks with no prefix set", () => {
		const errWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const j = stdioJournal();
			// Same idea for the err sink, exercising the empty-prefix branch of
			// the `prefix ? … : text` ternary while the chunk is a string.
			// oxlint-disable-next-line no-underscore-dangle -- Node stream internal
			(j.err as unknown as { _write: (c: unknown, e: string, cb: () => void) => void })._write(
				"plain",
				"utf8",
				() => {
					/* no-op */
				},
			);
			expect(errWrite).toHaveBeenCalledWith("plain");
		} finally {
			errWrite.mockRestore();
		}
	});
});
