#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

if [ "$#" -eq 0 ]; then
  (cd "$repo_root" && "${BUN:-bun}" run build)
  source_binary="$repo_root/dist/pacer"
else
  source_binary=$1
fi

if [ ! -f "$source_binary" ]; then
  printf 'stage-cli: source is missing or not a regular file: %s\n' "$source_binary" >&2
  exit 1
fi
if [ ! -x "$source_binary" ]; then
  printf 'stage-cli: source is not executable: %s\n' "$source_binary" >&2
  exit 1
fi

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
printf '%s\n' "$destination"
