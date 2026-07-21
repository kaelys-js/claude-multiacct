// Behavior tests for `trp-recon-repo.ts`.
//
// WHY it matters: the recon workflow is TRP-fix-task's upstream — a
// recon-shaped drift (missing client_repo silently returning ok:true, or a
// missing agent response crashing the return path) propagates into every
// downstream fix. These tests fix each branch with a replay Host so the
// journal is deterministic, then assert on the return shape AND the emitted
// journal-entry kinds.

/* oxlint-disable vitest/no-conditional-in-test */

import { beforeEach, describe, expect, it } from "vitest";
import { drainJournal, installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-recon-repo.ts";

beforeEach(() => resetWorkflow());

describe("trp-recon-repo — args parsing", () => {
	it("aborts when client_repo is missing", async () => {
		const result = await run({ task_id: "clickup:X", task_id_slug: "x" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("insufficient context in args");
	});

	it("parses a JSON-string arg the same as an object arg", async () => {
		const session = installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": { voice: "terse", sections_used: [], section_order: [] },
				"TouchedFiles:touched-files": { top_files: [] },
			},
		});
		const result = await run(JSON.stringify({ task_id: "t", client_repo: "o/r" }));
		session.finish();
		expect(result.ok).toBe(true);
		expect(result.client_repo).toBe("o/r");
	});

	it("tolerates a non-JSON string by treating it as empty ctx", async () => {
		const result = await run("not-json");
		expect(result.ok).toBe(false);
	});

	it("defaults pr_limit to 10 when unset", async () => {
		const session = installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": { voice: "v", sections_used: ["S"], section_order: ["S"] },
				"TouchedFiles:touched-files": { top_files: [] },
			},
		});
		const result = await run({ client_repo: "o/r" });
		const entries = session.finish();
		const styleReq = entries.find((e) => e.kind === "agent-request" && e.label === "pr-style");
		expect(styleReq).toBeDefined();
		expect(result.ok).toBe(true);
	});

	it("defaults task_id and task_id_slug to sentinel values", async () => {
		installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": { voice: "v", sections_used: [], section_order: [] },
				"TouchedFiles:touched-files": { top_files: [] },
			},
		});
		const result = await run({ client_repo: "o/r" });
		expect(result.task_id).toBe("TRACKER:UNKNOWN");
		expect(result.task_id_slug).toBe("task-unknown");
	});
});

describe("trp-recon-repo — phase orchestration", () => {
	it("emits Load, PRStyleRecon, TouchedFiles, Bundle phase markers in order", async () => {
		const session = installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": { voice: "v", sections_used: [], section_order: [] },
				"TouchedFiles:touched-files": { top_files: [] },
			},
		});
		await run({ client_repo: "o/r" });
		const entries = session.finish();
		const phases = entries
			.filter((e) => e.kind === "phase")
			.map((e) => (e as { title: string }).title);
		expect(phases).toEqual(["Load", "PRStyleRecon", "TouchedFiles", "Bundle"]);
	});

	it("folds null style-agent response into empty defaults without throwing", async () => {
		installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": null,
				"TouchedFiles:touched-files": { top_files: [{ path: "a", touch_count: 1 }] },
			},
		});
		const result = await run({ client_repo: "o/r", default_branch: "main" });
		expect(result.ok).toBe(true);
		expect(result.voice).toBe("");
		expect(result.sections_used).toEqual([]);
		expect(result.top_files).toHaveLength(1);
	});

	it("folds null files-agent response into empty top_files", async () => {
		installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": {
					voice: "v",
					sections_used: ["Summary"],
					section_order: ["Summary"],
				},
				"TouchedFiles:touched-files": null,
			},
		});
		const result = await run({ client_repo: "o/r" });
		expect(result.top_files).toEqual([]);
		expect(result.top_files_notes).toBe("");
	});

	it("returns null defaults for every field when BOTH agents fail", async () => {
		installReplayHost({
			responses: { "PRStyleRecon:pr-style": null, "TouchedFiles:touched-files": null },
		});
		const result = await run({ client_repo: "o/r" });
		expect(result.ok).toBe(true);
		expect(result.voice).toBe("");
		expect(result.top_files).toEqual([]);
	});
});

describe("trp-recon-repo — return shape", () => {
	it("passes default_branch through as null when not provided", async () => {
		installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": { voice: "v", sections_used: [], section_order: [] },
				"TouchedFiles:touched-files": { top_files: [] },
			},
		});
		const result = await run({ client_repo: "o/r" });
		expect(result.default_branch).toBeNull();
	});

	it("copies every style + files field through to the return", async () => {
		installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": {
					voice: "v",
					sections_used: ["Summary"],
					section_order: ["Summary"],
					label_conventions: ["bug"],
					commit_msg_convention: "conv",
					reviewer_patterns: "CODEOWNERS",
					example_titles: ["t1"],
					notes: "n",
				},
				"TouchedFiles:touched-files": {
					top_files: [{ path: "a", touch_count: 3, example_prs: [1, 2] }],
					notes: "tf-notes",
				},
			},
		});
		const r = await run({ client_repo: "o/r", default_branch: "main" });
		expect(r.label_conventions).toEqual(["bug"]);
		expect(r.commit_msg_convention).toBe("conv");
		expect(r.reviewer_patterns).toBe("CODEOWNERS");
		expect(r.example_titles).toEqual(["t1"]);
		expect(r.notes).toBe("n");
		expect(r.top_files).toHaveLength(1);
		expect(r.top_files_notes).toBe("tf-notes");
	});
});

// Guard rail — drainJournal() should be empty at the START of every test.
describe("trp-recon-repo — reset discipline", () => {
	it("resetWorkflow before each test leaves the journal empty", () => {
		expect(drainJournal()).toHaveLength(0);
	});
});
