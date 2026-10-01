#!/usr/bin/env bash
set -euo pipefail

for pair in \
  MACOS_CERTIFICATE:CSC_LINK \
  MACOS_CERTIFICATE_PASSWORD:CSC_KEY_PASSWORD \
  MACOS_SIGNING_IDENTITY:MACOS_SIGNING_IDENTITY \
  ASC_API_KEY_P8:ASC_API_KEY_P8 \
  ASC_API_KEY_ID:ASC_API_KEY_ID \
  ASC_API_ISSUER_ID:ASC_API_ISSUER_ID; do
  secret=${pair%%:*}
  variable=${pair##*:}
  if [[ -z "${!variable:-}" ]]; then
    echo "::error::$secret is missing from the desktop-build environment. See docs/macos-signing.md."
    exit 1
  fi
done

if [[ ! "$ASC_API_KEY_ID" =~ ^[A-Z0-9]+$ ]]; then
  echo "::error::ASC_API_KEY_ID must be the App Store Connect key ID."
  exit 1
fi

umask 077
signing_dir=$(mktemp -d "${RUNNER_TEMP:?}/easel-signing.XXXXXX")
export APPLE_API_KEY="$signing_dir/AuthKey_${ASC_API_KEY_ID}.p8"
export APPLE_API_KEY_ID="$ASC_API_KEY_ID"
export APPLE_API_ISSUER="$ASC_API_ISSUER_ID"
notary_result="$signing_dir/notarization.json"
trap 'rm -f "$APPLE_API_KEY" "$notary_result"; rmdir "$signing_dir"' EXIT

# electron-builder expects a key file path and chooses Apple ID auth first.
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
printf '%s' "$ASC_API_KEY_P8" | base64 -d > "$APPLE_API_KEY"

npm run dist:mac -- \
  --config.forceCodeSigning=true \
  --config.mac.identity="$MACOS_SIGNING_IDENTITY" \
  --config.mac.hardenedRuntime=true \
  --config.mac.notarize=true \
  --config.dmg.sign=true

shopt -s nullglob
apps=(release/mac*/*.app)
dmgs=(release/*.dmg)
if (( ${#apps[@]} == 0 || ${#dmgs[@]} == 0 )); then
  echo "::error::The build did not produce an app and disk image."
  exit 1
fi

for app in "${apps[@]}"; do
  codesign --verify --deep --strict --verbose=2 "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=4 "$app"
done

# The ZIP contains the stapled app; notarize and staple the DMG container too.
for dmg in "${dmgs[@]}"; do
  codesign --verify --strict --verbose=2 "$dmg"
  xcrun notarytool submit "$dmg" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait --timeout 15m --output-format json > "$notary_result"
  node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(`DMG notarization: ${result.status} (${result.id})`);
    if (result.status !== "Accepted") {
      console.error("::error::Apple did not accept the disk image for notarization.");
      process.exit(1);
    }
  ' "$notary_result"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
done
