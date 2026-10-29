#!/bin/sh
# Put the real pacer and pacer-core siblings back into a built AppImage.
#
# linuxdeploy runs patchelf on every ELF file in usr/bin, and that rewrite
# corrupts Bun-compiled binaries (the arm64 one segfaults). The AppImage is
# therefore built with placeholders for both executables. This script swaps
# the real pair in afterwards without touching the AppImage runtime.
#
#   repack-appimage.sh <file.AppImage> <pacer CLI> <expected version>
#
# Needs squashfs-tools. Runs on a host that can execute the AppImage runtime.
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: repack-appimage.sh <file.AppImage> <pacer CLI> <expected version>" >&2
  exit 2
fi
appimage=$1 cli=$2 version=$3
cli_name=$(basename -- "$cli")
case "$cli_name" in
  pacer-*) core="$(dirname -- "$cli")/pacer-core-${cli_name#pacer-}" ;;
  *) core="$(dirname -- "$cli")/pacer-core" ;;
esac
for tool in unsquashfs mksquashfs; do
  command -v "$tool" >/dev/null || { echo "repack-appimage: $tool is required (squashfs-tools)" >&2; exit 1; }
done
[ -f "$appimage" ] || { echo "repack-appimage: no AppImage at $appimage" >&2; exit 1; }
appimage=$(CDPATH= cd -- "$(dirname -- "$appimage")" && pwd)/$(basename -- "$appimage")
for payload in "$cli" "$core"; do
  [ -f "$payload" ] && [ -x "$payload" ] || { echo "repack-appimage: missing executable: $payload" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod +x "$appimage"
offset=$("$appimage" --appimage-offset)
case "$offset" in ''|*[!0-9]*) echo "repack-appimage: unexpected runtime offset: $offset" >&2; exit 1 ;; esac

head -c "$offset" "$appimage" > "$work/runtime"
unsquashfs -q -no-progress -d "$work/root" -o "$offset" "$appimage" >/dev/null
mkdir -p "$work/home"
for name in pacer pacer-core; do
  [ -e "$work/root/usr/bin/$name" ] || { echo "repack-appimage: AppImage has no usr/bin/$name" >&2; exit 1; }
done
install -m 0755 "$cli" "$work/root/usr/bin/pacer"
install -m 0755 "$core" "$work/root/usr/bin/pacer-core"

# Exercise each sibling separately: the native --version need not exec the core.
for name in pacer pacer-core; do
  got=$(HOME="$work/home" PACER_HOME="$work/home/.pacer" "$work/root/usr/bin/$name" --version)
  [ "$got" = "pacer $version" ] || { echo "repack-appimage: bundled $name reports '$got', expected 'pacer $version'" >&2; exit 1; }
done

# appimagetool's defaults: zstd, 128 KiB blocks, root-owned files.
mksquashfs "$work/root" "$work/fs" -comp zstd -b 131072 -root-owned -noappend -no-progress -quiet >/dev/null
cat "$work/runtime" "$work/fs" > "$work/out.AppImage"
chmod 0755 "$work/out.AppImage"
mv "$work/out.AppImage" "$appimage"
echo "repack-appimage: $appimage now bundles pacer and pacer-core $version"
