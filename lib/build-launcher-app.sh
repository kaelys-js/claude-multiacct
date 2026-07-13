#!/usr/bin/env bash
# lib/build-launcher-app.sh — generate the "Claude Account <Label>.app" Dock-clickable
# launcher bundle. Runs the codesign + xattr + lsregister dance that macOS
# Gatekeeper requires for ad-hoc bundles launched via LaunchServices (Dock).
#
# Usage: build-launcher-app.sh <label> <bundleId> <configDir> <userData> <appPath>
#
# Idempotent: safe to re-run. Snapshots any existing bundle first.

set -euo pipefail

# shellcheck source=./common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# The lsregister binary lives inside a private framework — hard-coded path.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

main() {
  local label="$1" bid="$2" cdir="$3" udata="$4" app="$5"
  cma_validate_label "$label"
  [[ -n "$bid" && -n "$cdir" && -n "$udata" && -n "$app" ]] || cma_die "build-launcher-app: missing args"

  local title; title="$(tr '[:lower:]' '[:upper:]' <<<"${label:0:1}")${label:1}"

  # Snapshot existing bundle if present.
  if [[ -d "$app" ]]; then
    local snap; snap="$(cma_backup_snapshot "$app" "launcher-app-$label")"
    cma_dim "  snapshot: $snap"
    rm -rf "$app"
  fi

  # Build the bundle skeleton.
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

  # The launcher shell script — same shape as the CLI launcher but embedded in
  # the .app so LaunchServices can spawn it from the Dock.
  cat >"$app/Contents/MacOS/launcher" <<LAUNCHER
#!/usr/bin/env bash
# Claude Account $title.app launcher — spawns Claude Desktop with per-instance
# CLAUDE_CONFIG_DIR + --user-data-dir. Regenerate via \`claude-multiacct repair $label\`.

exec open -na /Applications/Claude.app \\
  --env "CLAUDE_CONFIG_DIR=$cdir" \\
  --args --user-data-dir="$udata"
LAUNCHER
  chmod +x "$app/Contents/MacOS/launcher"

  # Info.plist. Uses CFBundleExecutable to point at the shell script.
  # LSBackgroundOnly = false so the app can front. LSUIElement omitted to keep
  # a normal Dock presence.
  cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>              <string>Claude Account $title</string>
    <key>CFBundleDisplayName</key>       <string>Claude Account $title</string>
    <key>CFBundleIdentifier</key>        <string>$bid</string>
    <key>CFBundleExecutable</key>        <string>launcher</string>
    <key>CFBundlePackageType</key>       <string>APPL</string>
    <key>CFBundleVersion</key>           <string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSMinimumSystemVersion</key>    <string>13.0</string>
    <key>LSApplicationCategoryType</key> <string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST

  # Best-effort xattr strip. Historically we recursively stripped
  # com.apple.provenance here, but 2026-07-13 verification showed:
  #   1. `xattr -d/-c/-rd com.apple.provenance` returns 0 but the xattr persists
  #      — it became a PROTECTED xattr on modern macOS (SIP-adjacent).
  #   2. Dock launch of an ad-hoc bundle with com.apple.provenance present DOES
  #      work (verified via `open -b <bundleId>` spawning the guest Claude).
  # Keep the call for older macOS versions where it does something; ignore the
  # rc since it's now expected to be a no-op.
  xattr -rd com.apple.provenance "$app" 2>/dev/null || true

  # Ad-hoc codesign — Gatekeeper's LaunchServices path silently rejects
  # unsigned bundles opened from the Dock. `--sign -` is ad-hoc (no cert).
  # `--force` re-signs an already-signed bundle. `--deep` covers nested items.
  # Errors here are fatal — a bundle that can't be codesigned won't Dock-launch.
  codesign --force --deep --sign - "$app" >/dev/null

  # Register with LaunchServices so the Dock knows about the bundle-id → path
  # mapping. Force re-register even if we've registered before.
  "$LSREGISTER" -f "$app" >/dev/null

  # Nudge the Dock to pick up any icon changes (harmless no-op if not needed).
  # We DON'T `killall Dock` unconditionally — that logs the user's Dock out
  # and rebuilds it, which surprises the user. The doctor subcommand offers
  # this as an interactive repair step.

  cma_ok "built $app (bundleId=$bid, ad-hoc codesigned)"
}

main "$@"
