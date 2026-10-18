#!/bin/sh
#  signing_hash=$( { [ -x /usr/bin/security ] && /usr/bin/security find-identity -v -p codesigning 2>/dev/null; } | pacer installer. Downloads the release binary for this OS and CPU, verifies its
# SHA-256 checksum against the release's SHA256SUMS, and installs it.
#
#   PACER_RELEASE_BASE     optional release root override, e.g.
#                          file:///path/to/pacer/dist/release   or   https://host/pacer/releases
#   PACER_INSTALL_VERSION  version to install (default: the "version" in <base>/latest.json)
#   PACER_INSTALL_DIR      install directory (default: $HOME/.local/bin)
#
# Layout under the base: latest.json, <version>/SHA256SUMS, <version>/pacer-<os>-<arch>.
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
if [ -z "${PACER_RELEASE_BASE:-}" ]; then
  latest=$base/latest/download/latest.json
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

version=${PACER_INSTALL_VERSION:-}
if [ -z "$version" ]; then
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
  *[!0-9A-Za-z.-]*) die "invalid version: $version" ;;
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

dir=${PACER_INSTALL_DIR:-}
if [ -z "$dir" ]; then
  [ -n "${HOME:-}" ] || die "HOME is not set; set PACER_INSTALL_DIR"
  dir=$HOME/.local/bin
fi
mkdir -p "$dir" || die "cannot create $dir"
# Stage next to the target, then rename: a running pacer is never overwritten in place.
stage=$dir/.pacer.install.$$
trap 'command rm -f "$stage"; command rm -rf "$tmp"' EXIT
cp "$tmp/$file" "$stage" || die "cannot write to $dir"
chmod 755 "$stage" || die "cannot prepare staged binary in $dir"
# Only sign the staged inode, after checksum verification and before the smoke run.
if [ "$os" = darwin ]; then
  signing_hash=$( { [ -x /usr/bin/security ] && /usr/bin/security find-identity -v -p codesigning 2>/dev/null; } | sed -n 's/^[[:space:]]*[0-9][0-9]*)[[:space:]]*\([A-Fa-f0-9]\{40\}\)[[:space:]]*"pacer local code signing"[[:space:]]*$/\1/p' | head -n 1)
  if [ -n "$signing_hash" ]; then
    say "Signing staged binary as dev.pacer.cli; unlock the login keychain if macOS requests authorization."
    /usr/bin/codesign -f -s "$signing_hash" -i dev.pacer.cli --options 0 \
      -r "designated => identifier \"dev.pacer.cli\" and certificate leaf = H\"$signing_hash\"" "$stage" || die "cannot sign staged binary"
    /usr/bin/codesign --verify --strict "$stage" || die "staged signature verification failed"
  fi
fi
installed=$("$stage" --version 2>/dev/null) || die "staged $dir/pacer does not run on this machine"
[ "$installed" = "pacer $version" ] || die "staged $dir/pacer reported '$installed', expected 'pacer $version'"
mv -f "$stage" "$dir/pacer" || die "cannot replace $dir/pacer"
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
say "  pacer init                 detect your AI tools and write ~/.pacer/strategy.yaml"
say "  pacer install <planner>    connect pacer to claude-code, codex, cursor or opencode"
