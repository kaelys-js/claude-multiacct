#!/usr/bin/env bash
# lib/build-clone-app.sh — build the per-instance "Claude Account <Label>.app"
# by cloning /Applications/Claude.app, rewriting its Info.plist to a unique
# bundle-id, and wrapping Contents/MacOS/Claude with a shell script that
# injects CLAUDE_CONFIG_DIR + --user-data-dir before exec-ing the real binary.
#
# Why a full clone (~745 MB per mirror) and not a shell launcher .app? macOS
# groups Dock items by CFBundleIdentifier of the RUNNING process. A shell
# launcher .app `open`s /Applications/Claude.app which is the same bundle-id
# as the primary — so the primary's Dock icon lights up and the mirror's
# stays inert. Only per-instance bundle-id parity between the Dock item and
# the running process fixes this. See docs/dock-icon-fix.md.
#
# Usage: build-clone-app.sh <label> <bundleId> <configDir> <userData> <appPath>
#
# Idempotent: safe to re-run. Snapshots the existing Info.plist first (not the
# whole 745 MB bundle — a snapshot-per-repair of the full bundle would burn disk).

set -euo pipefail

# shellcheck source=./common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# The lsregister binary lives inside a private framework — hard-coded path.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

main() {
  local label="$1" bid="$2" cdir="$3" udata="$4" app="$5"
  cma_validate_label "$label"
  [[ -n "$bid" && -n "$cdir" && -n "$udata" && -n "$app" ]] || cma_die "build-clone-app: missing args"

  local src="$CMA_SOURCE_CLAUDE_APP"
  [[ -d "$src" ]] || cma_die "source Claude Desktop bundle missing at $src (override with CMA_SOURCE_CLAUDE_APP)"
  [[ -f "$src/Contents/Info.plist" ]] || cma_die "source bundle at $src has no Contents/Info.plist"

  local title; title="$(tr '[:lower:]' '[:upper:]' <<<"${label:0:1}")${label:1}"

  # Snapshot the existing Info.plist ONLY. Rebuilds happen automatically after
  # every Claude Desktop update (via the WatchPaths agent), so a 745 MB snapshot
  # per rebuild would blow up ~/.claude-multiacct-backups within a week.
  if [[ -f "$app/Contents/Info.plist" ]]; then
    local snap; snap="$(cma_backup_snapshot "$app/Contents/Info.plist" "clone-plist-$label")"
    cma_dim "  snapshot: $snap (Info.plist only)"
  fi

  # Remove the existing bundle in its entirety (shell-launcher, older clone,
  # or half-written from a prior aborted run) so `ditto` writes into a clean tree.
  # We intentionally rm -rf even when Info.plist was just snapshotted — the
  # snapshot lives under CMA_BACKUP_DIR, not at $app.
  [[ -e "$app" ]] && rm -rf "$app"

  # Parent dir (usually ~/Applications) may not exist on a fresh machine.
  mkdir -p "$(dirname "$app")"

  # ditto preserves xattrs, resource forks, ACLs, and HFS+ metadata — critical
  # for the codesign structure to survive the copy. `cp -R` strips some of this.
  cma_say "cloning $src → $app (~745 MB; takes ~30s on SSD)"
  ditto "$src" "$app"

  # Read the executable name from the source's Info.plist (not hard-coded).
  # For today's Claude Desktop this is `Claude`, but reading it defends against
  # a future rename by Anthropic.
  local exe
  exe="$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")"
  [[ -n "$exe" ]] || cma_die "build-clone-app: could not read CFBundleExecutable from $app/Contents/Info.plist"
  [[ -f "$app/Contents/MacOS/$exe" ]] || cma_die "build-clone-app: expected executable $app/Contents/MacOS/$exe missing after ditto"

  # Rewrite the two identity fields that macOS surfaces:
  #   - CFBundleIdentifier  → per-instance value (the Dock-grouping fix — see docs/dock-icon-fix.md)
  #   - CFBundleDisplayName → per-instance label ("Claude Account <Title>" in the Dock)
  #
  # DELIBERATELY DO NOT rewrite CFBundleName. Chromium/Electron derives the
  # helper .app folder name from CFBundleName + " Helper" (see
  # electron_main_delegate_mac.mm:66). If CFBundleName is "Claude Account B",
  # Electron looks for Contents/Frameworks/"Claude Account B Helper.app" —
  # which doesn't exist (the ditto'd clone has "Claude Helper.app") — and
  # fatally exits with "Unable to find helper app" before any window opens.
  # 2026-07-13 verified by rewriting CFBundleName and reproducing the FATAL,
  # then reverting and confirming the clone boots.
  #
  # CFBundleDisplayName drives what the user sees in the Dock, app switcher,
  # and menu bar. It does NOT affect helper resolution. Rewriting it is safe.
  plutil -replace CFBundleIdentifier  -string "$bid"                    "$app/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string "Claude Account $title"   "$app/Contents/Info.plist"

  # Move the real binary out of the way so we can put the wrapper at its name.
  mv "$app/Contents/MacOS/$exe" "$app/Contents/MacOS/$exe.real"

  # Write the wrapper. \$@ / \$0 / \$(...) are backslash-escaped so they land
  # literally in the generated script (heredoc without quoted terminator would
  # otherwise expand them at generation time). $cdir / $udata / $exe / $label
  # DO expand — those are the per-instance values we want baked in.
  #
  # `exec -a "$exe"` sets argv[0] of the exec'd real binary back to the
  # original executable name (e.g. "Claude"). Load-bearing: Electron's
  # ElectronMainDelegate::OverrideChildProcessPath() (electron_main_delegate_mac.mm:66)
  # derives the helper-app name from the main executable's basename. Without
  # `-a "$exe"`, argv[0] would be "$exe.real" and Electron would look for
  # "Contents/Frameworks/Claude.real Helper.app" — which doesn't exist —
  # and fatally exit with "Unable to find helper app" before any window opens.
  # 2026-07-13 verified by direct-exec of the wrapper without `-a`.
  cat >"$app/Contents/MacOS/$exe" <<WRAPPER
#!/usr/bin/env bash
# Injects the mirror instance's config + user-data-dir before exec-ing the real
# Claude Desktop binary. Regenerate via \`claude-multiacct repair $label\`.
export CLAUDE_CONFIG_DIR="$cdir"
exec -a "$exe" "\$(dirname "\$0")/$exe.real" --user-data-dir="$udata" "\$@"
WRAPPER
  chmod +x "$app/Contents/MacOS/$exe"

  # Best-effort xattr strip. Historically we recursively stripped
  # com.apple.provenance here, but 2026-07-13 verification showed:
  #   1. `xattr -d/-c/-rd com.apple.provenance` returns 0 but the xattr persists
  #      — it became a PROTECTED xattr on modern macOS (SIP-adjacent).
  #   2. Dock launch of an ad-hoc bundle with com.apple.provenance present DOES
  #      work (verified via `open -b <bundleId>` spawning the guest Claude).
  # Keep the call for older macOS versions where it does something; ignore the
  # rc since it's now expected to be a no-op.
  xattr -rd com.apple.provenance "$app" 2>/dev/null || true

  # Ad-hoc re-sign the entire clone. Required because we mutated Info.plist
  # (breaks the original signature's plist hash) and injected a wrapper
  # (breaks the executable's code hash). `--force` overwrites the existing
  # signature; `--deep` re-signs every nested framework, helper .app, and
  # dylib in Contents/Frameworks — otherwise those keep the original
  # Developer ID signature which no longer matches the mutated outer bundle.
  # Errors here are fatal — a bundle that can't be codesigned won't Dock-launch.
  cma_say "codesign --force --deep --sign - $app (~10-30s for a full Electron bundle)"
  codesign --force --deep --sign - "$app" >/dev/null

  # Register with LaunchServices so the Dock knows about the bundle-id → path
  # mapping. `-f` forces re-register even if the path was previously registered
  # under a different (stale) bundle-id.
  "$LSREGISTER" -f "$app" >/dev/null

  cma_ok "built clone $app (bundleId=$bid, ad-hoc codesigned)"
}

main "$@"
