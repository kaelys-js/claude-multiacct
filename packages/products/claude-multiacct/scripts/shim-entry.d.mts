/**
 * Types for `shim-entry.mjs` — the shared shim entry string + bundler, so the
 * `build-shim.test.ts` import is typed rather than implicit `any`.
 */

/** The exact entry `dist/shim.js` is built from. */
export const shimEntryContents: string;

/** Options for {@link buildShimBundle}. */
export type BuildShimBundleOptions = {
	pkgRoot: string;
	outfile: string;
	logLevel?: "warning" | "silent";
};

/** Bundle `shimEntryContents` to `outfile` with the shipped esbuild options. */
export function buildShimBundle(opts: BuildShimBundleOptions): Promise<void>;
