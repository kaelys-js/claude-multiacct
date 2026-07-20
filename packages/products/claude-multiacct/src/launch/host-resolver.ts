/**
 * `@foundation/claude-multiacct` — Chromium `--host-resolver-rules` renderer.
 *
 * The extension (PR5b) is loaded via Claude's `REACT_PROFILE=1` dev hook
 * against `session.defaultSession.loadExtension`. That path avoids the
 * Chrome Web Store entirely, but the underlying Chromium runtime still
 * hits `clients2.google.com` and `chrome.google.com` for extension update
 * pings. We blackhole those to `0.0.0.0` via `--host-resolver-rules` so
 * the extension can't reach the CWS registry no matter what state the
 * embedded webstore integration is in.
 *
 * Rule-1 note: `electron-devtools-installer` is not in this workspace's
 * node_modules to pin the exact set of endpoints from; the two names
 * below are the standard Chromium CWS + install probes from the
 * Chromium source (chrome/browser/extensions/updater/). PR5b's extension
 * landed without pulling that package as a dep, so this list can only be
 * ratified against a live app trace in PR6 — leaving both names in place.
 *
 * Chromium's parser accepts comma-separated rules (with or without
 * whitespace around the commas). We emit `,` without whitespace — the
 * output goes into an argv element that Chromium parses back into rules;
 * the shorter form is unambiguous and easier to eyeball in logs.
 *
 * @module
 */

/**
 * Endpoints blackholed by the wrapper. Add here if a new probe host is
 * discovered — the wrapper picks up the change with no other edits.
 */
export const CWS_ENDPOINTS: readonly string[] = ["clients2.google.com", "chrome.google.com"];

/**
 * Render a Chromium `--host-resolver-rules` value string.
 *
 * @param {readonly string[]} endpoints - Hosts to blackhole to `0.0.0.0`.
 * @returns {string} Comma-separated `MAP <host> 0.0.0.0` clauses.
 */
export function renderHostResolverRules(endpoints: readonly string[]): string {
	return endpoints.map((h) => `MAP ${h} 0.0.0.0`).join(",");
}
