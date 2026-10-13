#!/bin/sh
# Run from your own account (the one that builds pacer) before the fresh-account
# onboarding test in docs/testing/onboarding.md.
# Copies a pacer release and the built Orca plugin to /Users/Shared so a fresh
# macOS account can install them without GitHub. Not needed once the release is
# published on GitHub Releases and the orca-plugin-v<version> tag exists.
#
#   sh scripts/onboarding-test/stage.sh [pacer checkout, default .]
# The checkout needs 'bun run release:host' and 'bun run plugin:build' first.
set -eu
src=${1:-.}
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/package.json" | head -n 1)
[ -f "$src/dist/release/$version/SHA256SUMS" ] || { echo "no release for $version: run 'bun run release:host' in $src" >&2; exit 1; }
[ -f "$src/orca-plugin/dist/orca-plugin.json" ] || { echo "no plugin build: run 'bun run plugin:build' in $src" >&2; exit 1; }
dest=/Users/Shared/pacer-onboarding-test
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$src/dist/release" "$dest/release"
cp -R "$src/orca-plugin/dist" "$dest/plugin"
cp "$(dirname "$0")/check.sh" "$dest/check.sh"
chmod -R a+rX "$dest"
echo "staged pacer $version:"
echo "  release folder: file://$dest/release"
echo "  plugin folder:  $dest/plugin"
