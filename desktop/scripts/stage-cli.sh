#!/bin/sh
set -eu

if [ "$#" -gt 2 ]; then
  echo "usage: stage-cli.sh [pacer [pacer-core]]" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

if [ "$#" -eq 0 ]; then
  (cd "$repo_root" && "${BUN:-bun}" run build)
  source_binary="$repo_root/dist/pacer"
else
  source_binary=$1
fi

# Release files carry a platform suffix; local builds use the plain sibling.
source_name=$(basename -- "$source_binary")
case "$source_name" in
  pacer-*) default_core="$(dirname -- "$source_binary")/pacer-core-${source_name#pacer-}" ;;
  *) default_core="$(dirname -- "$source_binary")/pacer-core" ;;
esac
source_core=${2:-$default_core}
for payload in "$source_binary" "$source_core"; do
  if [ ! -f "$payload" ]; then
    printf 'stage-cli: source is missing or not a regular file: %s\n' "$payload" >&2
    exit 1
  fi
  if [ ! -x "$payload" ]; then
    printf 'stage-cli: source is not executable: %s\n' "$payload" >&2
    exit 1
  fi
done

target_triple=${TAURI_TARGET_TRIPLE:-}
if [ -z "$target_triple" ]; then
  rust_version=$(cd "$repo_root/desktop/src-tauri" && rustc -vV)
  target_triple=$(printf '%s\n' "$rust_version" | sed -n 's/^host: //p')
fi
if [ -z "$target_triple" ]; then
  printf 'stage-cli: could not determine the Rust host target triple\n' >&2
  exit 1
fi

destination="$repo_root/desktop/src-tauri/binaries/pacer-$target_triple"
mkdir -p "$repo_root/desktop/src-tauri/binaries"
cp -- "$source_binary" "$destination"
chmod 0755 "$destination"
core_destination="$repo_root/desktop/src-tauri/binaries/pacer-core-$target_triple"
cp -- "$source_core" "$core_destination"
chmod 0755 "$core_destination"
printf '%s\n' "$destination"
