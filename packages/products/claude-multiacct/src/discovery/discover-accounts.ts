/**
 * `@foundation/claude-multiacct` — reconcile the pool's native account.
 *
 * Discovery's job is NOT "import every OAuth token on the machine" (the old
 * scan-everything behaviour triplicated one real account into `account-1/2/3`).
 * It is narrow and identity-anchored:
 *
 *   1. Detect the account Claude.app is natively signed into — its real
 *      `accountUuid`, its token, and its real identity — via
 *      `native-account.ts::detectNativeAccount` (config.json
 *      `lastKnownAccountUuid` → tokenCacheV2 → profile API).
 *   2. If a pooled account already carries that `accountUuid`, do nothing:
 *      dedup is by the real account uuid, so the native account is registered
 *      exactly once no matter how many cached tokens or CLI slots point at it.
 *   3. Otherwise register it as the `native` account with its real identity.
 *
 * Explicitly-added accounts (the `explicit` source) are never touched here —
 * they are added through the `POST /accounts` path in a later change, and this
 * reconcile leaves them exactly as they are.
 *
 * Fail-closed: when detection returns `undefined` (no marker, keychain blind,
 * no token whose profile matches the marker) discovery registers nothing and
 * leaves the registry untouched. Every side effect is injected via `ports`.
 *
 * @module
 */

import type { AccountIdentity, AccountUuid, ClaudeAccountUuid } from "../domain/account.ts";
import { type AccountRegistry, byAccountUuid } from "../domain/registry.ts";
import type { DetectedNativeAccount } from "./native-account.ts";

/** Injected side-effect surface for the native reconcile. */
export type DiscoveryPorts = {
	/** Detect the native Claude.app account, or `undefined` when none resolves. */
	detectNative: () => Promise<DetectedNativeAccount | undefined>;
	/** Read the current registry (used for accountUuid dedup + idempotency). */
	readRegistry: () => Promise<AccountRegistry | undefined>;
	/**
	 * Register the native account. Called at most once per run, only when no
	 * pooled account already carries its `accountUuid`. Returns the assigned
	 * local pool uuid, or a classified failure.
	 */
	provisionNative: (input: {
		token: string;
		label: string;
		accountUuid: ClaudeAccountUuid;
		identity: AccountIdentity;
		subscriptionType: string;
		rateLimitTier: string;
	}) => Promise<{ ok: true; uuid: AccountUuid } | { ok: false; kind: string; detail: string }>;
	/** Log sink for warnings / progress. */
	logger: { log: (m: string) => void; warn: (m: string) => void };
};

/** Outcome of a reconcile run. */
export type DiscoveryOutcome = {
	/** The native account when detection resolved one, else `undefined`. */
	detected:
		| { accountUuid: ClaudeAccountUuid; email: string | undefined; displayName: string | undefined }
		| undefined;
	/** The account registered this run (freshly added), or `undefined`. */
	registered: { uuid: AccountUuid; label: string } | undefined;
	/** True when the native account was already in the pool (dedup hit). */
	alreadyRegistered: boolean;
	/** Classified failure when provisioning the native account failed. */
	failed: { kind: string; detail: string } | undefined;
};

/**
 * Reconcile the native account into the pool. See module docstring.
 *
 * @param {DiscoveryPorts} ports - Injected side-effects.
 * @returns {Promise<DiscoveryOutcome>} What was detected / registered / skipped.
 */
export async function discoverAccounts(ports: DiscoveryPorts): Promise<DiscoveryOutcome> {
	const outcome: DiscoveryOutcome = {
		detected: undefined,
		registered: undefined,
		alreadyRegistered: false,
		failed: undefined,
	};

	const native = await ports.detectNative();
	if (native === undefined) {
		return outcome;
	}
	outcome.detected = {
		accountUuid: native.accountUuid,
		email: native.identity.email,
		displayName: native.identity.displayName,
	};

	// Dedup by the real Claude account uuid — one real account is one entry.
	const registry = await ports.readRegistry();
	if (registry !== undefined && byAccountUuid(registry, native.accountUuid) !== undefined) {
		outcome.alreadyRegistered = true;
		ports.logger.log(
			`discovery: native account ${native.accountUuid} already registered; skipping`,
		);
		return outcome;
	}

	const label = deriveNativeLabel(native.identity);
	const result = await ports.provisionNative({
		token: native.token,
		label,
		accountUuid: native.accountUuid,
		identity: native.identity,
		subscriptionType: native.subscriptionType,
		rateLimitTier: native.rateLimitTier,
	});
	if (result.ok) {
		outcome.registered = { uuid: result.uuid, label };
		ports.logger.log(`discovery: registered native ${label} (${native.accountUuid})`);
	} else {
		outcome.failed = { kind: result.kind, detail: result.detail };
		ports.logger.warn(`discovery: native registration failed: ${result.kind}: ${result.detail}`);
	}
	return outcome;
}

/**
 * Derive a meaningful, human label for the native account from its identity.
 * NEVER returns `account-N`: an email maps to a provider/domain label, else the
 * display name is slugified, else the literal `native`.
 *
 * @param {AccountIdentity} identity - The account's real identity.
 * @returns {string} A non-empty label.
 */
export function deriveNativeLabel(identity: AccountIdentity): string {
	const fromEmail = labelFromEmail(identity.email);
	if (fromEmail !== undefined) {
		return fromEmail;
	}
	const fromName = slug(identity.displayName);
	if (fromName !== undefined) {
		return fromName;
	}
	return "native";
}

/**
 * Map an email to a short label: known consumer providers collapse to a
 * friendly name, otherwise the domain's first label is used.
 *
 * @param {string | undefined} email - The account email.
 * @returns {string | undefined} A label, or `undefined` when no email.
 */
function labelFromEmail(email: string | undefined): string | undefined {
	if (email === undefined) {
		return undefined;
	}
	if (email.endsWith("@icloud.com") || email.endsWith("@me.com") || email.endsWith("@mac.com")) {
		return "icloud";
	}
	if (email.endsWith("@gmail.com") || email.endsWith("@googlemail.com")) {
		return "gmail";
	}
	const at = email.indexOf("@");
	if (at >= 0) {
		const [first] = email.slice(at + 1).split(".");
		if (first !== undefined && first.length > 0) {
			return first;
		}
	}
	return undefined;
}

/**
 * Slugify a display name into a label (lowercase, spaces → hyphens). Empty /
 * whitespace-only → `undefined`.
 *
 * @param {string | undefined} name - The display name.
 * @returns {string | undefined} A slug, or `undefined`.
 */
function slug(name: string | undefined): string | undefined {
	if (name === undefined) {
		return undefined;
	}
	const s = name.trim().toLowerCase().replaceAll(/\s+/gu, "-");
	return s.length > 0 ? s : undefined;
}
