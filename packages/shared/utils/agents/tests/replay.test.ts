// Behavior tests for `@foundation/agents`'s replay adapter.
//
// WHY it matters: replay is what makes the Phase 3 ROADMAP proof ("identical
// journal.jsonl") a well-defined check. If replayKey drifted from `phase:label`,
// fixture files would silently mis-dispatch. If ts normalization did not
// overwrite the primitive's timestamp, replay journals would drift with wall
// clock. If install/finish did not restore the previous host, one fixture's
// state would leak into the next. If a missing key threw instead of returning
// null, an incomplete fixture would crash the whole workflow instead of
// degrading to null-and-continue. These tests fix each contract.

import { beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	drainJournal,
	getHost,
	installReplayHost,
	makeReplayHost,
	replayKey,
	resetWorkflow,
	setHost,
	type Host,
} from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

describe("replayKey", () => {
	it("joins phase and label with a single colon", () => {
		expect(replayKey("TaskRecon", "pr-style")).toBe("TaskRecon:pr-style");
	});

	it("tolerates empty phase or label without coercing to something ambiguous", () => {
		expect(replayKey("", "lbl")).toBe(":lbl");
		expect(replayKey("P", "")).toBe("P:");
	});
});

describe("makeReplayHost — dispatch", () => {
	it("answers with the recorded response when the phase:label key is present", async () => {
		const { host } = makeReplayHost({
			responses: { "TaskRecon:pr-style": { voice: "terse" } },
		});
		const result = await host.dispatchAgent({
			prompt: "anything",
			label: "pr-style",
			phase: "TaskRecon",
			schema: { type: "object" },
		});
		expect(result).toEqual({ voice: "terse" });
	});

	it("answers with null when the phase:label key is missing", async () => {
		const { host } = makeReplayHost({ responses: {} });
		const result = await host.dispatchAgent({
			prompt: "anything",
			label: "absent",
			phase: "Nowhere",
			schema: { type: "object" },
		});
		expect(result).toBeNull();
	});

	it("handles a recorded null response distinctly (still null downstream)", async () => {
		const { host } = makeReplayHost({ responses: { "P:l": null } });
		const result = await host.dispatchAgent({
			prompt: "",
			label: "l",
			phase: "P",
			schema: {},
		});
		expect(result).toBeNull();
	});
});

describe("makeReplayHost — ts normalization", () => {
	it("overwrites primitive-emitted ts with a monotonic counter starting at 0", () => {
		const { host, drain } = makeReplayHost({ responses: {} });
		host.journalWrite({ kind: "phase", title: "A", ts: 999_999 });
		host.journalWrite({ kind: "log", message: "m", ts: 999_999 });
		host.journalWrite({ kind: "phase", title: "B", ts: 999_999 });
		const entries = drain();
		expect(entries.map((e) => e.ts)).toEqual([0, 1, 2]);
	});

	it("preserves the other fields verbatim while overwriting ts", () => {
		const { host, drain } = makeReplayHost({ responses: {} });
		host.journalWrite({
			kind: "agent-response",
			label: "pr-style",
			phase: "TaskRecon",
			ok: true,
			ts: 1234,
		});
		const entries = drain();
		expect(entries[0]).toEqual({
			kind: "agent-response",
			label: "pr-style",
			phase: "TaskRecon",
			ok: true,
			ts: 0,
		});
	});

	it("drain empties the buffer so a second drain sees nothing", () => {
		const { host, drain } = makeReplayHost({ responses: {} });
		host.journalWrite({ kind: "phase", title: "A", ts: 0 });
		expect(drain()).toHaveLength(1);
		expect(drain()).toEqual([]);
	});

	it("now() returns the current counter, non-decreasing", () => {
		const { host } = makeReplayHost({ responses: {} });
		const a = host.now();
		host.journalWrite({ kind: "phase", title: "X", ts: 0 });
		const b = host.now();
		expect(b).toBeGreaterThanOrEqual(a);
	});
});

describe("installReplayHost — install / finish", () => {
	it("installs the replay host so agent() dispatches through it", async () => {
		const session = installReplayHost({
			responses: { "P:l": { hello: "world" } },
		});
		const result = await agent("prompt", {
			label: "l",
			phase: "P",
			schema: { type: "object" },
		});
		expect(result).toEqual({ hello: "world" });
		session.finish();
	});

	it("finish returns the journal with monotonic ts starting at 0 and restores the previous host", async () => {
		const before: Host = getHost();
		const session = installReplayHost({
			responses: { "P:l": { ok: 1 } },
		});
		await agent("prompt", { label: "l", phase: "P", schema: { type: "object" } });
		const emitted = session.finish();
		expect(emitted.map((e) => e.ts)).toEqual([0, 1]);
		expect(getHost()).toBe(before);
	});

	it("finish drains the buffer so a second finish returns []", async () => {
		const session = installReplayHost({ responses: {} });
		await agent("p", { label: "a", phase: "P", schema: {} });
		expect(session.finish().length).toBeGreaterThan(0);
		// Second call after finish restored the previous host — session's drain
		// still empties its own buffer, so a subsequent call returns [].
		expect(session.finish()).toEqual([]);
	});

	it("leaves the default in-process buffer alone (isolation)", async () => {
		// Prime the default buffer BEFORE installing the replay host.
		getHost().journalWrite({ kind: "log", message: "before", ts: 1 });
		const session = installReplayHost({ responses: {} });
		await agent("p", { label: "a", phase: "P", schema: {} });
		session.finish();
		// After finish restores the default host, the pre-install entry should
		// still be drainable — the replay session did not touch it.
		const pending = drainJournal();
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ kind: "log", message: "before" });
	});
});

describe("replay — used with a foreign previous host", () => {
	it("restores an operator-supplied previous host after finish, not just the default", () => {
		const previousCapture: unknown[] = [];
		const previous: Host = {
			dispatchAgent: () => Promise.resolve({ tag: "previous" }),
			journalWrite: (e) => previousCapture.push(e),
			now: () => 7,
		};
		setHost(previous);
		const session = installReplayHost({ responses: { "P:l": { tag: "replay" } } });
		session.finish();
		expect(getHost()).toBe(previous);
	});
});
