/**
 * `@foundation/agents` — phase marker.
 *
 * `phase()` stamps a marker into the workflow journal at the top of each
 * logical stage. Purely observability — the marker groups downstream
 * `agent()` and `log()` entries so a journal reader can section the run.
 * Does not gate execution; a workflow that calls `phase('X')` and then
 * throws still emits the phase marker.
 *
 * @module
 */

import { getHost } from "./host.ts";

export function phase(title: string): void {
	const host = getHost();
	host.journalWrite({ kind: "phase", title, ts: host.now() });
}
