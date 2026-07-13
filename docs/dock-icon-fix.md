# The Dock icon fix

## Symptom

You click the "Claude Account B.app" icon in the Dock. Nothing happens. No window opens, no error dialog appears, no Gatekeeper prompt. `open ~/Applications/Claude\ Account\ B.app` from a terminal works fine, though — that's the confusing part.

## Root cause

Gatekeeper has two enforcement paths:

- **Shell `open`**: skips the "is this signed at all" check. Ad-hoc bundles launch fine.
- **Dock click (LaunchServices)**: enforces the check. Unsigned + provenance-tagged bundles get silently rejected. No dialog because Gatekeeper's silent-fail path fires when the launch source is inferred as user-driven and the bundle is inferred as trusted-but-broken.

Two attributes make LaunchServices reject a bundle:
1. No codesignature at all (fails `codesign -v`)
2. Presence of `com.apple.provenance` extended attribute (marks the bundle as "opened from a downloadable source", requires notarised signature)

## The three-part fix

Every bundle installed by `claude-multiacct` (via `lib/build-launcher-app.sh`) gets:

```sh
codesign --force --deep --sign - "<app path>"
xattr -d com.apple.provenance "<app path>" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "<app path>"
```

### 1. `codesign --force --deep --sign -`

Ad-hoc signature (`-` means "no cert, self-attested"). Gatekeeper's LaunchServices path checks for the PRESENCE of a signature — the identity doesn't have to be a Developer ID. `--force` overwrites any existing signature. `--deep` covers nested bundles (harmless for our flat structure but future-proof).

### 2. `xattr -d com.apple.provenance`

Strips the "downloaded from browser" quarantine attribute. Fresh local builds usually don't have it, but backup+restore, `cp -R` between filesystems, or Time Machine restores can spuriously apply it. When present, Gatekeeper rejects even ad-hoc signatures.

`|| true` — the attribute may not exist and `xattr -d` returns non-zero when it isn't present; we don't want that to fail the install.

### 3. `lsregister -f`

Force-register the bundle-ID → path mapping. Without this, LaunchServices may have a stale cache pointing at the old bundle location (if you moved the .app) or no entry at all (if you built the bundle fresh). `-f` forces re-registration regardless of prior state.

### 4. (Sometimes needed) `killall Dock`

The Dock caches icons in RAM. Even after `lsregister -f` sets up the registration correctly, the Dock might still be displaying the STALE icon it cached earlier and route clicks to the old dead binding. `killall Dock` restarts the Dock (rebuilds from LaunchServices state) — no user data loss, just a Dock restart.

The installer does NOT run `killall Dock` unconditionally because it's user-visible (the Dock disappears for ~1 second). Run it manually if `claude-multiacct doctor` reports the fix looks correct but clicks still don't fire.

## Verifying the fix

`claude-multiacct doctor` runs these checks per instance:

| Check | Command | Failure mode reported |
|---|---|---|
| Codesign valid | `codesign -v "<app>"` | `codesign-broken` |
| Provenance xattr absent | `xattr "<app>" \| grep -q com.apple.provenance` (negated) | `provenance-xattr-present` |
| LaunchServices registered | `lsregister -dump \| grep -F "<app>"` | `ls-not-registered` |

Any failed check triggers a `--suggest` line pointing at `claude-multiacct repair <label>`.

## Manual diagnosis when repair doesn't stick

If `claude-multiacct repair <label>` reports success but Dock click still fails:

```sh
# 1. Full xattr dump on the bundle.
xattr -lr ~/Applications/Claude\ Account\ B.app

# 2. Deep codesign detail — look for CodeDirectory version + team identifier.
codesign -dvvv ~/Applications/Claude\ Account\ B.app

# 3. LaunchServices dump for the bundle-ID.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep -A5 "com.claude-multiacct.claude-account-b-launcher"

# 4. Try open via bundle-ID explicitly (the same path Dock uses internally).
open -b com.claude-multiacct.claude-account-b-launcher
# If this fails but `open <app path>` succeeds, the LaunchServices registration is broken.

# 5. Nuclear option: force LaunchServices to rescan every bundle on disk.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user
killall Dock
```

If step 4 works but Dock still fails, the Dock has cached an old routing. `killall Dock` clears it.

If step 4 fails with a codesign / provenance error, capture the exact error message and open an issue — that's a new failure mode we haven't seen yet.
