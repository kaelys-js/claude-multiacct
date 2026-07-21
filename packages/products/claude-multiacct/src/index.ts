/**
 * `@foundation/claude-multiacct` — runtime product entry point.
 *
 * Scaffold only. This PR forks the foundation toolchain and stands up an empty
 * product package; the OAuth-pool runtime lands in later PRs and gets re-exported
 * from here as modules stabilise. The two constants below give the package an
 * identity the test suite can pin, so vitest and the coverage gate have real
 * source to run against before any product code exists.
 *
 * @module
 */

/** Workspace package name. Kept in sync with the `name` field in package.json. */
export const PACKAGE_NAME = "@foundation/claude-multiacct";

/** Package version. Kept in sync with the `version` field in package.json. */
export const PACKAGE_VERSION = "0.0.0";
