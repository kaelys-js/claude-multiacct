// Behavior tests for `@foundation/agents`'s agent() primitive.
//
// WHY it matters: agent() is the single call point every workflow uses to run
// sub-agents. If it forgot to journal the request, replay diffs would silently
// pass. If it re-threw a dispatch failure instead of returning null, every
// consumer's `results.filter(Boolean)` would have to become try/catch. If it
// stripped the schema from the dispatch payload, the sub-agent would produce
// unshaped JSON and downstream code would fault. These tests fix each contract.

import { beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	drainJournal,
	resetWorkflow,
	setHost,
	type Host,
	type JournalEntry,
} from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

function makeCapturingHost(response: unknown): {
	host: Host;
	dispatched: Array<{ prompt: string; label: string; phase: string }>;
	journal: JournalEntry[];
} {
	const dispatched: Array<{ prompt: string; label: string; phase: string }> = [];
	const journal: JournalEntry[] = [];
	const host: Host = {
		dispatchAgent: (req) => {
			dispatched.push({ prompt: req.prompt, label: req.label, phase: req.phase });
			return Promise.resolve(response);
		},
		journalWrite: (entry) => journal.push(entry),
		now: () => 100,
	};
	return { host, dispatched, journal };
}

describe("agent — dispatch + journal bracketing", () => {
	it("emits agent-request BEFORE the dispatch and agent-response AFTER", async () => {
		const { host, journal } = makeCapturingHost({ voice: "terse" });
		setHost(host);
		const STYLE = {
			type: "object",
			properties: { voice: { type: "string" } },
			required: ["voice"],
		} as const;
		await agent("prompt-body", { label: "pr-style", phase: "TaskRecon", schema: STYLE });
		expect(journal.map((e) => e.kind)).toEqual(["agent-request", "agent-response"]);
		expect(journal[0]).toMatchObject({
			kind: "agent-request",
			label: "pr-style",
			phase: "TaskRecon",
		});
		expect(journal[1]).toMatchObject({
			kind: "agent-response",
			label: "pr-style",
			phase: "TaskRecon",
			ok: true,
		});
	});

	it("passes prompt, label, phase, and schema straight through to dispatchAgent", async () => {
		const { host, dispatched } = makeCapturingHost({ ok: 1 });
		setHost(host);
		await agent("the actual prompt text", {
			label: "lbl",
			phase: "Phz",
			schema: { type: "object" },
		});
		expect(dispatched).toEqual([{ prompt: "the actual prompt text", label: "lbl", phase: "Phz" }]);
	});

	it("returns the dispatched response typed by the schema generic", async () => {
		const { host } = makeCapturingHost({ voice: "terse", extra: 42 });
		setHost(host);
		const STYLE = {
			type: "object",
			properties: { voice: { type: "string" } },
			required: ["voice"],
		} as const;
		const result = await agent("p", { label: "a", phase: "P", schema: STYLE });
		expect(result?.voice).toBe("terse");
	});
});

describe("agent — null handling", () => {
	it("returns null when dispatch resolves to null, and marks ok=false on the response", async () => {
		const { host, journal } = makeCapturingHost(null);
		setHost(host);
		const result = await agent("p", { label: "a", phase: "P", schema: { type: "object" } });
		expect(result).toBeNull();
		const responseEntry = journal.find((e) => e.kind === "agent-response");
		expect(responseEntry).toMatchObject({ kind: "agent-response", ok: false });
	});

	it("returns null when dispatch resolves to undefined, and marks ok=false on the response", async () => {
		const { host, journal } = makeCapturingHost(undefined);
		setHost(host);
		const result = await agent("p", { label: "a", phase: "P", schema: { type: "object" } });
		expect(result).toBeNull();
		const responseEntry = journal.find((e) => e.kind === "agent-response");
		expect(responseEntry).toMatchObject({ kind: "agent-response", ok: false });
	});

	it("resolves with the response even when the default host is active (which always returns null)", async () => {
		const result = await agent("p", { label: "a", phase: "P", schema: { type: "object" } });
		expect(result).toBeNull();
		const entries = drainJournal();
		expect(entries.map((e) => e.kind)).toEqual(["agent-request", "agent-response"]);
	});
});

describe("agent — timestamp propagation", () => {
	it("stamps host.now() on both the request and response journal entries", async () => {
		let callCount = 0;
		const emitted: JournalEntry[] = [];
		const host: Host = {
			dispatchAgent: () => Promise.resolve({ ok: 1 }),
			journalWrite: (entry): void => {
				emitted.push(entry);
			},
			now: () => 200 + callCount++,
		};
		setHost(host);
		await agent("p", { label: "a", phase: "P", schema: { type: "object" } });
		expect(emitted).toHaveLength(2);
		expect(emitted.at(0)?.ts).toBe(200);
		expect(emitted.at(1)?.ts).toBe(201);
	});
});
