#!/bin/sh
# pacer installer. Downloads release executables for this OS and CPU, verifies their
# SHA-256 checksum against the release's SHA256SUMS, and installs it.
#
#   PACER_RELEASE_BASE     optional release root override, e.g.
#                          file:///path/to/pacer/dist/release   or   https://host/pacer/releases
#   PACER_INSTALL_VERSION  version to install (default: the "version" in <base>/latest.json)
#   PACER_INSTALL_CHANNEL  stable (default) or nightly: nightly also reads cli-nightly.json
#                          and installs the newer of it and latest.json.
#                          PACER_INSTALL_VERSION wins over the channel.
#   PACER_INSTALL_DIR      install directory (default: $HOME/.local/bin)
#
# Layout under the base: latest.json, [cli-nightly.json,] <version>/SHA256SUMS, <version>/pacer-<os>-<arch>.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'pacer install: %s\n' "$*" >&2; exit 1; }

# fetch <url> <dest>
fetch() {
  case $1 in
    file://*)
      src=${1#file://}
      [ -f "$src" ] || die "not found: $1"
      cp "$src" "$2" || die "cannot copy $1"
      ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl --proto '=https,http,file' --proto-redir '=https' --max-redirs 5 -fsSL "$1" -o "$2" || die "download failed: $1"
      elif command -v wget >/dev/null 2>&1; then
        url=$1
        hops=0
        while :; do
          status=0
          wget --max-redirect=0 --server-response -q -O "$2" "$url" 2>"$tmp/headers" || status=$?
          location=$(sed -n 's/^[[:space:]]*[Ll]ocation:[[:space:]]*//p' "$tmp/headers" | sed 's/ [[]following[]]$//' | tr -d '\r' | head -n 1)
          [ -n "$location" ] || { [ "$status" = 0 ] || die "download failed: $url"; break; }
          [ "$hops" -lt 5 ] || die "redirect limit (5) exceeded: $1"
          case $location in
            https://*) url=$location ;;
            //*) url=https:$location ;;
            /*) case $url in
                  https://*) url=$(printf '%s' "$url" | sed 's#\(https://[^/]*\).*#\1#')$location ;;
                  *) die "redirect must target https://: $location" ;;
                esac ;;
            *) die "redirect must target https://: $location" ;;
          esac
          case $url in
            https://*@*) die "redirect must not contain user info: $url" ;;
          esac
          hops=$((hops + 1))
        done
      else
        die "need curl or wget to download $1"
      fi
      ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else
    die "need sha256sum, shasum or openssl to verify the download"
  fi
}

channel=${PACER_INSTALL_CHANNEL:-stable}
case $channel in
  stable | nightly) ;;
  *) printf 'pacer install: PACER_INSTALL_CHANNEL must be stable or nightly (got: %s)\n' "$channel" >&2; exit 2 ;;
esac

GITHUB_REPO=lamtuanvu/pacer
base=${PACER_RELEASE_BASE:-https://github.com/$GITHUB_REPO/releases}
case $base in
  *\?* | *\#*) die "PACER_RELEASE_BASE must not contain ? or # (got: $base)" ;;
esac
while :; do
  case $base in
    */) base=${base%/} ;;
    *) break ;;
  esac
done
case $base in
  *@*) die "PACER_RELEASE_BASE must not contain user info (got: $base)" ;;
esac
case $base in
  https://* | file://* | http://127.0.0.1 | http://127.0.0.1:* | http://127.0.0.1/* | http://localhost | http://localhost:* | http://localhost/*) ;;
  *) die "PACER_RELEASE_BASE must start with https://, file://, or http://127.0.0.1 / http://localhost (got: $base)" ;;
esac

latest=$base/latest.json
nightly_feed=$base/cli-nightly.json
if [ -z "${PACER_RELEASE_BASE:-}" ]; then
  latest=$base/latest/download/latest.json
  nightly_feed=https://raw.githubusercontent.com/$GITHUB_REPO/desktop-updates/cli-nightly.json
fi

s=$(uname -s)
case $s in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS: $s (pacer builds exist for macOS and Linux)" ;;
esac
m=$(uname -m)
case $m in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU: $m (pacer builds exist for x86_64 and arm64)" ;;
esac
# A shell running under Rosetta reports x86_64 on Apple Silicon: install the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ]; then
  for f in /lib/ld-musl-*; do
    if [ -e "$f" ]; then die "musl-based Linux (for example Alpine) is not supported yet"; fi
  done
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t pacer)
trap 'command rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

# feed_version <url> <dest>: the feed's "version" without a leading v; empty when the feed cannot be read.
feed_version() {
  ( fetch "$1" "$2" ) 2>"$tmp/feed.err" || { cat "$tmp/feed.err" >&2; return 0; }
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$2" | head -n 1 | sed 's/^v//'
}

# newer <a> <b>: the newer of a stable version and a nightly one, by semver precedence.
newer() {
  ca=${1%%[-+]*}
  cb=${2%%[-+]*}
  order=$(awk -v a="$ca" -v b="$cb" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) { print 1; exit } if (x[i] + 0 < y[i] + 0) { print -1; exit } } print 0 }')
  case $order in
    1) printf '%s\n' "$1" ;;
    -1) printf '%s\n' "$2" ;;
    # Equal cores: a release beats its own prerelease.
    *) case $1 in *-*) printf '%s\n' "$2" ;; *) printf '%s\n' "$1" ;; esac ;;
  esac
}

version=${PACER_INSTALL_VERSION:-}
if [ -z "$version" ] && [ "$channel" = nightly ]; then
  # Nightly installs take the newer of both feeds; a feed that fails leaves the other.
  stable_version=$(feed_version "$latest" "$tmp/latest.json")
  if ! printf '%s\n' "$stable_version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.+-]+)?$'; then
    printf 'pacer install: warning: could not read a version from %s\n' "$latest" >&2
    stable_version=
  fi
  nightly_version=$(feed_version "$nightly_feed" "$tmp/cli-nightly.json")
  if ! printf '%s\n' "$nightly_version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-nightly\.[1-9][0-9]{11}$'; then
    printf 'pacer install: warning: no valid nightly version in %s\n' "$nightly_feed" >&2
    nightly_version=
  fi
  if [ -n "$stable_version" ] && [ -n "$nightly_version" ]; then
    version=$(newer "$stable_version" "$nightly_version")
  else
    version=${nightly_version:-$stable_version}
  fi
  [ -n "$version" ] || die "could not read a version from $nightly_feed or $latest"
elif [ -z "$version" ]; then
  fetch "$latest" "$tmp/latest.json"
  version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -n 1)
  [ -n "$version" ] || die "could not read a version from $latest"
fi
version=${version#v}
case $version in
  [0-9]*) ;;
  *) die "invalid version: $version" ;;
esac
case $version in
  *[!0-9A-Za-z.+-]*) die "invalid version: $version" ;;
esac

release=$base/$version
if [ -z "${PACER_RELEASE_BASE:-}" ]; then
  release=$base/download/v$version
fi
file=pacer-$os-$arch
fetch "$release/SHA256SUMS" "$tmp/SHA256SUMS"
expected=$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "release $version has no build for $os-$arch"
fetch "$release/$file" "$tmp/$file"
actual=$(sha256 "$tmp/$file")
[ "$actual" = "$expected" ] || die "checksum mismatch for $file (expected $expected, got $actual); nothing was installed"

core_file=pacer-core-$os-$arch
core_expected=$(awk -v f="$core_file" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")
if [ -n "$core_expected" ]; then
  fetch "$release/$core_file" "$tmp/$core_file"
  core_actual=$(sha256 "$tmp/$core_file")
  [ "$core_actual" = "$core_expected" ] || die "checksum mismatch for $core_file; nothing was installed"
fi

dir=${PACER_INSTALL_DIR:-}
if [ -z "$dir" ]; then
  [ -n "${HOME:-}" ] || die "HOME is not set; set PACER_INSTALL_DIR"
  dir=$HOME/.local/bin
fi
mkdir -p "$dir" || die "cannot create $dir"
# Keep staging on the destination filesystem and use exclusive temporary names.
stage=$(mktemp "$dir/.pacer.install.XXXXXX") || die "cannot stage in $dir"
core_stage=
core_backup=
core_installed=0
front_installed=0
preserve_backup=0
cleanup() {
  if [ "$core_installed" = 1 ] && [ "$front_installed" = 0 ]; then
    if [ -n "$core_backup" ]; then
      if ! mv -f "$core_backup" "$dir/pacer-core"; then
        preserve_backup=1
        printf 'pacer install: core rollback failed; previous core retained at %s\n' "$core_backup" >&2
      fi
    else
      command rm -f "$dir/pacer-core" || printf 'pacer install: cannot remove newly installed core\n' >&2
    fi
  fi
  command rm -f "$stage"
  [ -z "$core_stage" ] || command rm -f "$core_stage"
  if [ "$preserve_backup" = 0 ] && [ -n "$core_backup" ]; then command rm -f "$core_backup"; fi
  command rm -rf "$tmp"
}
trap cleanup EXIT
cp "$tmp/$file" "$stage" || die "cannot write to $dir"
chmod 755 "$stage" || die "cannot prepare staged binary in $dir"
if [ -n "$core_expected" ]; then
  if [ -e "$dir/pacer-core" ] || [ -L "$dir/pacer-core" ]; then
    if [ ! -f "$dir/pacer-core" ] || [ -L "$dir/pacer-core" ]; then die "pacer-core must be a regular file"; fi
  fi
  core_stage=$(mktemp "$dir/.pacer-core.install.XXXXXX") || die "cannot stage core in $dir"
  cp "$tmp/$core_file" "$core_stage" || die "cannot stage core in $dir"
  chmod 755 "$core_stage" || die "cannot prepare staged core in $dir"
fi
# Only sign verified staged inodes, before either smoke run or installed-file mutation.
if [ "$os" = darwin ]; then
  signing_hash=$( { [ -x /usr/bin/security ] && /usr/bin/security find-identity -v -p codesigning 2>/dev/null; } | sed -n 's/^[[:space:]]*[0-9][0-9]*)[[:space:]]*\([A-Fa-f0-9]\{40\}\)[[:space:]]*"pacer local code signing"[[:space:]]*$/\1/p' | head -n 1)
  if [ -n "$signing_hash" ]; then
    say "Signing staged binary as dev.pacer.cli; unlock the login keychain if macOS requests authorization."
    for staged in "$stage" "$core_stage"; do
      [ -n "$staged" ] || continue
      /usr/bin/codesign -f -s "$signing_hash" -i dev.pacer.cli --options 0 \
        -r "=designated => identifier \"dev.pacer.cli\" and certificate leaf = H\"$signing_hash\"" "$staged" || die "cannot sign staged binary"
      /usr/bin/codesign --verify --strict "$staged" || die "staged signature verification failed"
    done
  fi
fi
installed=$("$stage" --version 2>/dev/null) || die "staged $dir/pacer does not run on this machine"
[ "$installed" = "pacer $version" ] || die "staged $dir/pacer reported '$installed', expected 'pacer $version'"
if [ -n "$core_stage" ]; then
  core_version=$("$core_stage" --version 2>/dev/null) || die "staged core does not run on this machine"
  [ "$core_version" = "pacer $version" ] || die "staged core reported '$core_version', expected 'pacer $version'"
  if [ -f "$dir/pacer-core" ]; then
    core_backup=$(mktemp "$dir/.pacer-core.backup.XXXXXX") || die "cannot back up core"
    cp -p "$dir/pacer-core" "$core_backup" || die "cannot back up core"
  fi
  # Defer termination until the pair is committed or the core is rolled back.
  interrupted=0
  trap 'interrupted=1' INT TERM
  core_installed=1
  mv -f "$core_stage" "$dir/pacer-core" || die "cannot replace $dir/pacer-core"
fi
mv -f "$stage" "$dir/pacer" || die "cannot replace $dir/pacer"
front_installed=1
[ "${interrupted:-0}" = 0 ] || exit 130
trap 'exit 130' INT TERM
say "installed: $installed ($dir/pacer)"
case ":${PATH:-}:" in
  *":$dir:"*) ;;
  *)
    say ""
    say "note: $dir is not on your PATH. Add this line to your shell profile:"
    say "  export PATH=\"$dir:\$PATH\""
    ;;
esac
say ""
say "next steps:"
say "  pacer init    detect tools, write ~/.pacer/strategy.yaml and connect agents after asking"
