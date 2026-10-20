#!/bin/sh
# Put the real pacer CLI back into a built AppImage.
#
# linuxdeploy runs patchelf on every ELF file in usr/bin, and that rewrite
# corrupts Bun-compiled binaries (the arm64 one segfaults). The AppImage is
# therefore built with a placeholder CLI, and this script swaps the real one
# in afterwards without touching the AppImage runtime.
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
for tool in unsquashfs mksquashfs; do
  command -v "$tool" >/dev/null || { echo "repack-appimage: $tool is required (squashfs-tools)" >&2; exit 1; }
done
[ -f "$appimage" ] || { echo "repack-appimage: no AppImage at $appimage" >&2; exit 1; }
appimage=$(CDPATH= cd -- "$(dirname -- "$appimage")" && pwd)/$(basename -- "$appimage")
[ -x "$cli" ] || { echo "repack-appimage: CLI is missing or not executable: $cli" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod +x "$appimage"
offset=$("$appimage" --appimage-offset)
case "$offset" in ''|*[!0-9]*) echo "repack-appimage: unexpected runtime offset: $offset" >&2; exit 1 ;; esac

head -c "$offset" "$appimage" > "$work/runtime"
unsquashfs -q -no-progress -d "$work/root" -o "$offset" "$appimage" >/dev/null
[ -e "$work/root/usr/bin/pacer" ] || { echo "repack-appimage: AppImage has no usr/bin/pacer" >&2; exit 1; }
install -m 0755 "$cli" "$work/root/usr/bin/pacer"

# Prove the bundled CLI runs before shipping it.
got=$(HOME="$work/home" "$work/root/usr/bin/pacer" --version)
[ "$got" = "pacer $version" ] || { echo "repack-appimage: bundled CLI reports '$got', expected 'pacer $version'" >&2; exit 1; }

# appimagetool's defaults: zstd, 128 KiB blocks, root-owned files.
mksquashfs "$work/root" "$work/fs" -comp zstd -b 131072 -root-owned -noappend -no-progress -quiet >/dev/null
cat "$work/runtime" "$work/fs" > "$work/out.AppImage"
chmod 0755 "$work/out.AppImage"
mv "$work/out.AppImage" "$appimage"
echo "repack-appimage: $appimage now bundles pacer $version"
