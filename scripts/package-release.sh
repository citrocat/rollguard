#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./extension/manifest.json').version")"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid manifest version: $VERSION" >&2
  exit 1
fi

if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
  TAG_VERSION="${GITHUB_REF_NAME#v}"
  if [[ "$TAG_VERSION" != "$VERSION" ]]; then
    echo "Tag ${GITHUB_REF_NAME} does not match manifest version ${VERSION}." >&2
    exit 1
  fi
fi

node scripts/build.mjs

RELEASE_ROOT="$ROOT/release"
BUNDLE="$RELEASE_ROOT/rollguard-$VERSION"
ZIP="$RELEASE_ROOT/rollguard-$VERSION.zip"
CHECKSUM="$ZIP.sha256"

case "$BUNDLE" in
  "$ROOT"/release/rollguard-*) ;;
  *) echo "Refusing to touch unexpected release path: $BUNDLE" >&2; exit 1 ;;
esac

rm -rf "$BUNDLE"
rm -f "$ZIP" "$CHECKSUM"
mkdir -p "$BUNDLE"
cp -R "$ROOT/dist/." "$BUNDLE/"

if [[ ! -f "$BUNDLE/manifest.json" ]]; then
  echo "Packaged bundle is missing manifest.json." >&2
  exit 1
fi

(
  cd "$RELEASE_ROOT"
  zip -qr "rollguard-$VERSION.zip" "rollguard-$VERSION"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "rollguard-$VERSION.zip" > "rollguard-$VERSION.zip.sha256"
  else
    shasum -a 256 "rollguard-$VERSION.zip" > "rollguard-$VERSION.zip.sha256"
  fi
)

echo "Built $ZIP"
echo "Built $CHECKSUM"
