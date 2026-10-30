#!/bin/sh
# Build the unsigned Linux AppImage and .deb with the real pacer and pacer-core siblings in both.
#
# linuxdeploy (AppImage only) rewrites every ELF in usr/bin with patchelf,
# which corrupts the Bun-compiled core (#217). The AppImage is built around
# placeholders for both siblings and repacked with the real pair; the .deb takes it directly.
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
cli_name=$(basename -- "$cli")
case "$cli_name" in
  pacer-*) core="$(dirname -- "$cli")/pacer-core-${cli_name#pacer-}" ;;
  *) core="$(dirname -- "$cli")/pacer-core" ;;
esac
for payload in "$cli" "$core"; do
  [ -f "$payload" ] && [ -x "$payload" ] || { echo "build-linux-bundles: missing executable: $payload" >&2; exit 1; }
done
target=${3:-}
smoke_home=$(mktemp -d)
trap 'rm -rf "$smoke_home"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
version=${2:-$(HOME="$smoke_home" PACER_HOME="$smoke_home/.pacer" "$cli" --version | sed 's/^pacer //')}
for payload in "$cli" "$core"; do
  got=$(HOME="$smoke_home" PACER_HOME="$smoke_home/.pacer" "$payload" --version)
  [ "$got" = "pacer $version" ] || { echo "build-linux-bundles: $payload reports '$got', expected 'pacer $version'" >&2; exit 1; }
done
target_args=${target:+--target $target}
bundle_dir="$desktop/src-tauri/target/${target:+$target/}release/bundle"

placeholder=$(mktemp)
trap 'rm -f "$placeholder"; rm -rf "$smoke_home"' EXIT
printf '#!/bin/sh\necho "pacer: placeholder CLI; the AppImage build did not repack it" >&2\nexit 1\n' > "$placeholder"
chmod 0755 "$placeholder"

cd "$desktop"
TAURI_TARGET_TRIPLE=$target ./scripts/stage-cli.sh "$placeholder" "$placeholder" >/dev/null
# shellcheck disable=SC2086 # target_args is empty or two words
bunx --no-install tauri build $target_args --bundles appimage --no-sign

TAURI_TARGET_TRIPLE=$target ./scripts/stage-cli.sh "$cli" "$core" >/dev/null
# shellcheck disable=SC2086
bunx --no-install tauri build $target_args --bundles deb --no-sign

set -- "$bundle_dir"/appimage/*.AppImage
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "build-linux-bundles: expected one AppImage in $bundle_dir/appimage" >&2; exit 1; }
./scripts/repack-appimage.sh "$1" "$cli" "$version"
