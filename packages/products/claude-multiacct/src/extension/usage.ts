/**
 * `@foundation/claude-multiacct` — per-account usage pill component.
 *
 * Polls `GET /usage/:accountUuid` every 60s, renders subscription + tier +
 * a remaining-quota bar + a relative reset time. Renders `—` when the
 * `/usage` endpoint returned `"unknown"` for `remainingRatio` — never
 * `NaN`, never `0`. The domain schema draws that distinction on purpose
 * (see `domain/usage.ts`); the UI has to mirror it.
 *
 * Polling pauses when the page is hidden. Chrome under memory pressure
 * throttles unfocused tabs anyway, but the explicit `visibilitychange`
 * gate is cheaper than a woken-up interval that fires a redundant request
 * before the throttle catches it, AND it survives tab focus in
 * always-on-top window modes (macOS's "always keep window visible").
 *
 * @module
 */

import type { BridgeClient } from "./bridge-client.ts";

export type UsageMountOptions = {
	host: Element;
	client: BridgeClient;
	accountUuid: string;
	doc: Document;
	/** Poll interval override for tests. Default 60_000. */
	intervalMs?: number;
	/** Setter shim; tests inject fake timers. Defaults to global. */
	setInterval?: (fn: () => void, ms: number) => number;
	/** Clearer shim; tests inject fake timers. Defaults to global. */
	clearInterval?: (handle: number) => void;
};

export type UsageHandle = {
	destroy(): void;
};

type UsageApiPayload = {
	ok: boolean;
	verify?: {
		subscription?: string;
		tier?: string;
		remainingRatio?: number | "unknown";
		resetAt?: string;
	};
};

function relativeTime(now: number, iso: string | undefined): string {
	if (iso === undefined) {
		return "";
	}
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const deltaSec = Math.round((then - now) / 1000);
	if (deltaSec <= 0) {
		return "now";
	}
	if (deltaSec < 3600) {
		return `${Math.round(deltaSec / 60)}m`;
	}
	if (deltaSec < 86_400) {
		return `${Math.round(deltaSec / 3600)}h`;
	}
	return `${Math.round(deltaSec / 86_400)}d`;
}

/**
 * Mount a usage pill on `host`. Fires an initial fetch synchronously (as a
 * microtask), then polls at `intervalMs` when the page is visible.
 *
 * @param {UsageMountOptions} opts - Host, client, account.
 * @returns {UsageHandle} `{destroy}` — clears the interval and removes DOM.
 */
export function mountUsage(opts: UsageMountOptions): UsageHandle {
	const setIv =
		opts.setInterval ??
		((fn: () => void, ms: number): number => setInterval(fn, ms) as unknown as number);
	const clearIv =
		opts.clearInterval ??
		((h: number): void => clearInterval(h as unknown as ReturnType<typeof setInterval>));
	const interval = opts.intervalMs ?? 60_000;

	const pill = opts.doc.createElement("span");
	pill.dataset.cmaUsage = opts.accountUuid;
	pill.style.fontSize = "11px";
	pill.style.marginLeft = "8px";
	pill.textContent = "…";
	opts.host.append(pill);

	let timer: number | undefined;
	let destroyed = false;

	function render(payload: UsageApiPayload["verify"] | undefined): void {
		if (payload === undefined) {
			pill.textContent = "—";
			return;
		}
		const sub = payload.subscription ?? "";
		const tier = payload.tier ?? "";
		const ratio = payload.remainingRatio;
		const reset = relativeTime(Date.now(), payload.resetAt);
		let ratioLabel: string;
		if (ratio === "unknown" || ratio === undefined) {
			ratioLabel = "—";
		} else {
			ratioLabel = `${Math.round(ratio * 100)}%`;
		}
		pill.textContent = `${sub} · ${tier} · ${ratioLabel}${reset === "" ? "" : ` · resets ${reset}`}`;
	}

	async function fetchOnce(): Promise<void> {
		const res = await opts.client.get<UsageApiPayload>(`/usage/${opts.accountUuid}`);
		if (destroyed) {
			return;
		}
		if (!res.ok) {
			render(undefined);
			return;
		}
		render(res.data.verify);
	}

	function startPolling(): void {
		if (timer !== undefined) {
			return;
		}
		timer = setIv(() => {
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget poll tick
			(async (): Promise<void> => {
				try {
					await fetchOnce();
				} catch {
					/* swallowed; render already handled the failure */
				}
			})();
		}, interval);
	}

	function stopPolling(): void {
		if (timer !== undefined) {
			clearIv(timer);
			timer = undefined;
		}
	}

	function onVisibility(): void {
		if (opts.doc.visibilityState === "visible") {
			startPolling();
		} else {
			stopPolling();
		}
	}

	opts.doc.addEventListener("visibilitychange", onVisibility);

	// Prime with an immediate fetch when visible.
	if (opts.doc.visibilityState === "visible") {
		// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget initial fetch
		(async (): Promise<void> => {
			try {
				await fetchOnce();
			} catch {
				/* swallowed */
			}
		})();
		startPolling();
	}

	return {
		destroy(): void {
			destroyed = true;
			stopPolling();
			opts.doc.removeEventListener("visibilitychange", onVisibility);
			pill.remove();
		},
	};
}
