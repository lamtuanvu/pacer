#!/bin/sh
# Build the unsigned Linux AppImage and .deb with the real pacer CLI in both.
#
# linuxdeploy (AppImage only) rewrites every ELF in usr/bin with patchelf,
# which corrupts the Bun-compiled CLI (#217). The AppImage is built around a
# placeholder and repacked with the real CLI; the .deb takes it directly.
#
#   build-linux-bundles.sh <pacer CLI> [expected version] [rust target triple]
#
# Without a version, the CLI's own --version is the expectation. Without a
# target, tauri builds for the host. Run from anywhere; set CARGO_NET_OFFLINE
# and similar build settings in the environment.
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "usage: build-linux-bundles.sh <pacer CLI> [expected version] [rust target triple]" >&2
  exit 2
fi
desktop=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cli=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")
target=${3:-}
version=${2:-$(HOME=$(mktemp -d) "$cli" --version | sed 's/^pacer //')}
target_args=${target:+--target $target}
bundle_dir="$desktop/src-tauri/target/${target:+$target/}release/bundle"

placeholder=$(mktemp)
trap 'rm -f "$placeholder"' EXIT
printf '#!/bin/sh\necho "pacer: placeholder CLI; the AppImage build did not repack it" >&2\nexit 1\n' > "$placeholder"
chmod 0755 "$placeholder"

cd "$desktop"
TAURI_TARGET_TRIPLE=$target ./scripts/stage-cli.sh "$placeholder" >/dev/null
# shellcheck disable=SC2086 # target_args is empty or two words
bunx --no-install tauri build $target_args --bundles appimage --no-sign

TAURI_TARGET_TRIPLE=$target ./scripts/stage-cli.sh "$cli" >/dev/null
# shellcheck disable=SC2086
bunx --no-install tauri build $target_args --bundles deb --no-sign

set -- "$bundle_dir"/appimage/*.AppImage
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "build-linux-bundles: expected one AppImage in $bundle_dir/appimage" >&2; exit 1; }
./scripts/repack-appimage.sh "$1" "$cli" "$version"
