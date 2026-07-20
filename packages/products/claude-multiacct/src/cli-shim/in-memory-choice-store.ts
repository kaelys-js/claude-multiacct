/**
 * `@foundation/claude-multiacct` — in-memory `ChoiceStore` for tests.
 *
 * Lives in its own file so oxlint's `max-classes-per-file` stays happy
 * alongside `FsChoiceStore`. Zero disk I/O; the shim's orchestration test
 * uses this to drive every branch (choice-present, choice-absent, stale
 * choice) without a scratch dir.
 *
 * @module
 */

import * as v from "valibot";
import {
	ChoiceStoreStateSchema,
	type ChoiceStoreState,
	type SessionAccountChoice,
} from "../domain/session-choice.ts";
import type { ChoiceStore } from "../ports.ts";

/** Map-backed `ChoiceStore` for tests. */
export class InMemoryChoiceStore implements ChoiceStore {
	private readonly state: Record<string, SessionAccountChoice> = {};

	read(): Promise<ChoiceStoreState> {
		return Promise.resolve(v.parse(ChoiceStoreStateSchema, { ...this.state }));
	}

	write(choice: SessionAccountChoice): Promise<void> {
		this.state[choice.sessionUuid] = choice;
		return Promise.resolve();
	}
}
