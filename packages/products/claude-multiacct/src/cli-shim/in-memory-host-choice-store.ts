/**
 * `@foundation/claude-multiacct` — in-memory `HostChoiceStore` for tests.
 *
 * Lives in its own file so oxlint's `max-classes-per-file` stays happy
 * alongside `FsHostChoiceStore`. Zero disk I/O; the shim's orchestration test
 * uses it to drive the restart-survival branch (a host choice present under a
 * fresh CLI uuid) without a scratch dir.
 *
 * @module
 */

import type { HostSessionChoice } from "../domain/host-session-choice.ts";
import type { HostChoiceStore } from "../ports.ts";

/** Map-backed `HostChoiceStore` for tests. */
export class InMemoryHostChoiceStore implements HostChoiceStore {
	private readonly state = new Map<string, HostSessionChoice>();

	read(hostSessionId: string): Promise<HostSessionChoice | undefined> {
		return Promise.resolve(this.state.get(hostSessionId));
	}

	write(choice: HostSessionChoice): Promise<void> {
		this.state.set(choice.hostSessionId, choice);
		return Promise.resolve();
	}
}
