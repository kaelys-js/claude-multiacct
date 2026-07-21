/**
 * `@foundation/agents` — token budget tracker.
 *
 * `budget` exposes the current workflow's token accounting: total (set by
 * the caller or the harness at startup), spent (accumulated by charge()
 * calls), and remaining (total minus spent, clamped to >=0). Charge is
 * additive; nothing in the primitive gates on remaining hitting zero — the
 * workflow's own logic decides whether to short-circuit (Rule 6: surface,
 * do not hide).
 *
 * The runtime primitives (agent, parallel, pipeline, phase, log) do not
 * auto-charge. Charging is explicit so a workflow can distinguish sub-agent
 * costs (large) from log/phase overhead (negligible), and so the harness
 * can inject its own token accounting via the Host adapter without every
 * primitive knowing about tokens.
 *
 * @module
 */

import { chargeBudget, getHost, getState, setTotalBudget } from "./host.ts";

export const budget = {
	total(): number {
		return getState().total;
	},
	spent(): number {
		return getState().spent;
	},
	remaining(): number {
		const state = getState();
		return Math.max(0, state.total - state.spent);
	},
	setTotal(total: number): void {
		setTotalBudget(total);
	},
	charge(amount: number): { spent: number; remaining: number } {
		const host = getHost();
		const { spent, remaining } = chargeBudget(amount);
		host.journalWrite({
			kind: "budget-charge",
			amount,
			spent,
			remaining,
			ts: host.now(),
		});
		return { spent, remaining };
	},
} as const;
