#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
asset_dir=${ASSET_DIR:-assets}

shopt -s nullglob
assets=(
  "$asset_dir"/*.exe
  "$asset_dir"/*.dmg
  "$asset_dir"/*.zip
  "$asset_dir"/*.AppImage
  "$asset_dir"/*.deb
)
if ((${#assets[@]} == 0)); then
  echo "No desktop package assets found in $asset_dir." >&2
  exit 1
fi

if gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY" --clobber
  if [[ "$RELEASE_TAG" == *-* ]]; then
    gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --prerelease
  fi
else
  create_args=(
    --repo "$GITHUB_REPOSITORY"
    --title "Easel Studio ${RELEASE_TAG#v}"
    --generate-notes
    --verify-tag
  )
  notes_file="docs/releases/$RELEASE_TAG.md"
  if [[ -f "$notes_file" ]]; then
    create_args+=(--notes-file "$notes_file")
  fi
  if [[ "$RELEASE_TAG" == *-* ]]; then
    create_args+=(--prerelease)
  fi
  gh release create "$RELEASE_TAG" "${assets[@]}" "${create_args[@]}"
fi
