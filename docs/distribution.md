# Distribution

Every tagged release (`vX.Y.Z`, see [CONTRIBUTING](../CONTRIBUTING.md#releasing)) produces one set of binaries. Each channel below repackages those same binaries.

| Channel | Install | Built from |
| --- | --- | --- |
| GitHub Releases | download `pacer-<os>-<arch>` and check it against `SHA256SUMS` | `release.yml` |
| install.sh | `curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh \| sh` | GitHub Releases |
| npm | `npm install -g @lamtuanvu/pacer` | `bun run release:npm` |
| Homebrew | `brew install lamtuanvu/tap/pacer` | `bun run release:homebrew` |
| Orca plugin | marketplace source `https://github.com/lamtuanvu/pacer.git` at ref `main` | `orca-plugin` branch and `orca-plugin-v<version>` tags |

Artifact attestations require a public repository (or GitHub Enterprise); real releases happen after this repository is public.

Verify where a binary came from with `gh attestation verify pacer-<os>-<arch> -R lamtuanvu/pacer`.

`bun run build` embeds the version from `package.json` in `dist/pacer`. Local commits
add build metadata from `git describe`, for example `0.2.3+12.gabc1234` (with
`.dirty` for uncommitted changes). Clean tagged checkouts and source archives
without Git use the package version. Update checks ignore build metadata and
offer only releases newer than that package version.

## npm

`bun run release:npm --release-dir dist/release/<version> --out dist/npm` builds five packages:

- `@lamtuanvu/pacer-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`: each holds one binary and limits itself to its platform with `os` and `cpu`.
- `@lamtuanvu/pacer`: a dependency-free Node launcher (`bin/pacer.js`). It lists the four platform packages as exact-version `optionalDependencies`, so npm installs only the matching one. The launcher runs that binary with `PACER_INSTALL_METHOD=npm`. `PACER_BINARY_PATH` overrides the binary.

The generator checks every binary against `manifest.json` (SHA-256 and size) before it writes anything. Publish the packages in the order given in `dist/npm/publish-order.txt`: the platform packages first, the launcher last.

### One-time bootstrap

npm trusted publishing can only be configured for packages that already exist, so the first version of each package is published by hand:

1. `npm login` (as `lamtuanvu`).
2. Download a release's binaries and `manifest.json` into a directory, then `bun run release:npm --release-dir <dir> --out dist/npm`.
3. For each directory in `publish-order.txt`: `npm publish dist/npm/<dir> --access public`.
4. On npmjs.com, open each of the five packages, go to **Settings → Trusted publishing**, and add GitHub Actions with repository `lamtuanvu/pacer` and workflow `release.yml`.

5. Set the repository Actions variable `NPM_TRUSTED_PUBLISHING` to `true` after configuring all five trusted publishers.

After that, CI publishes without any npm token. Until the variable is enabled, the npm job is skipped. Exact package versions already present on npm are skipped on retries; prereleases use the `next` dist-tag. Trusted publishing requires npm CLI 11.5.1+ and Node 22.14.0+, `permissions: id-token: write`, and a GitHub-hosted runner. Each package's `repository` field must match `github.com/lamtuanvu/pacer` exactly, including case ([npm docs](https://docs.npmjs.com/trusted-publishers), [provenance](https://docs.npmjs.com/generating-provenance-statements)).

## Homebrew

`bun run release:homebrew --manifest dist/release/<version>/manifest.json --out Formula/pacer.rb` writes a formula with per-OS, per-CPU release URLs and SHA-256 sums.

Tap setup:

1. Create the public repo `lamtuanvu/homebrew-tap`.
2. Create a fine-grained token with **Contents: read and write** on `lamtuanvu/homebrew-tap` only.
3. Store it as the `HOMEBREW_TAP_TOKEN` Actions secret in `lamtuanvu/pacer`.

The release workflow commits `Formula/pacer.rb` to the tap’s `main` branch with a sign-off. It skips prereleases, does nothing when the formula is unchanged, and prints `skipped: HOMEBREW_TAP_TOKEN not set` while the secret is missing.

## Orca plugin

On each release, `release.yml` publishes `orca-plugin/dist` as the root of the `orca-plugin` branch and tags it `orca-plugin-v<version>`. `orca-marketplace.json` on `main` points at that tag; `bun run release:prepare` bumps it. Users can add the marketplace or install `https://github.com/lamtuanvu/pacer.git#orca-plugin-v<version>` directly. The pacer CLI must be installed as well.

## Dry-run release validation

From a checkout whose package version, plugin bundle and changelog are prepared for the version, run:

```sh
gh workflow run release.yml -f version=<x.y.z> -f dry_run=true
```

The workflow checks the input against `package.json`, builds and smoke-tests all four binaries, writes metadata, and prints asset SHA-256 hashes and release notes. It exercises the plugin branch/tag publishing steps against a throwaway local bare repository and prints the proposed plugin tag. npm packages are generated from workflow artifacts and checked with `npm publish --dry-run` regardless of `NPM_TRUSTED_PUBLISHING`. Homebrew generates and prints its formula and checks it with `ruby -c` without needing the tap token.

Dry runs skip attestations, GitHub release uploads, remote plugin pushes, npm publication and tap pushes. Build artifacts expire after one day. A dispatch with `dry_run=false` is refused; only version tags can publish releases.

## Signed macOS desktop updates

Desktop releases are independent of the CLI's `latest.json`. A stable desktop
feed is published at
`https://raw.githubusercontent.com/lamtuanvu/pacer/desktop-updates/stable.json`
only after **both** native macOS packages pass signature, notarization,
architecture and embedded metadata validation. A CLI-only release, prerelease,
failed build or missing architecture leaves the existing desktop feed in place.
Linux desktop builds remain unsigned manual workflow artifacts.

The release workflow has an opt-in `desktop-release` environment. Keep the
repository variable `PACER_DESKTOP_RELEASE_ENABLED` unset until the signed native
validation matrix and baseline manual installation have been accepted. The
implementation does not configure credentials or enable publishing. With the
variable set to `true`, stable version tags build natively on `macos-15`
(Apple Silicon) and `macos-15-intel` (Intel), sign and notarize each complete app,
then validate the pair on macOS before publishing. Runner availability is
specified by [GitHub's hosted runner matrix](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
a successful local ARM build does not establish Intel coverage.

Release CI requires these explicitly configured inputs:

| Input | Storage | Purpose |
| --- | --- | --- |
| `PACER_OTA_PUBLIC_KEY` | Actions variable | Base64 Tauri updater public key, compiled into the native app/helper |
| `PACER_APPLE_TEAM_ID` | Actions variable | Ten-character Team ID compiled into the app/helper and desktop's bundled CLI |
| `PACER_APPLE_SIGNING_IDENTITY` | Actions variable | Exact 40-hex Developer ID Application certificate fingerprint |
| `PACER_APPLE_CERTIFICATE_BASE64`, `PACER_APPLE_CERTIFICATE_PASSWORD` | Protected secrets | Developer ID Application P12 and its password |
| `PACER_NOTARY_KEY`, `PACER_NOTARY_KEY_ID`, `PACER_NOTARY_ISSUER` | Protected secret for the key; variables for IDs | App Store Connect API key for notarization |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Protected secrets | Tauri updater signing key and optional password |

These are build/release inputs, never runtime update configuration. Production
native builds use the `ota-production` Cargo feature and fail closed without
trust inputs. The bundled CLI is built separately under `dist/desktop-cli` with
`--desktop-production`, so its compiled Team ID and manifest/checksums cannot
replace standalone CLI release bytes. Ordinary CLI builds retain their existing
behavior. Updater key backup and custody must be arranged before the first
baseline release: losing the private key prevents signing updates for apps that
pin its public key. Key rotation needs a separately reviewed migration.

The signer creates a private temporary keychain, imports only the release
certificate, signs the fixed native transport library, CLI and helper before the
outer app, and restores the
original keychain search list during cleanup. An `always()` cleanup step can
resume after cancellation from its private record. No login keychain import or
unsigned fallback is supported. The Bun CLI receives only `allow-jit`; the Rust
executables receive no runtime exceptions. After the final signatures, each native CI runner executes the CLI transport
self-test with its verified library, private socket and kernel peer identity,
and starts the helper's native runtime with its updater plugin.
Failure blocks notarization and publication. Real Developer ID execution on both
architectures remains a release prerequisite. The current package supports
regular files/directories, three executables and
`Contents/Frameworks/libpacer-native.dylib`. Xcode clang builds the library from
the tracked transport source for the package architecture and macOS 11 minimum.
It has the identifier `dev.pacer.desktop.native-shim` and the same signing Team
as the CLI. A compatible detached CLI uses only the library beside its own
executable. Compiled native-enabled CLIs never fall back to runtime C compilation.
Library validation stays enabled; additional nested code or symlink payloads
require a reviewed signing/extraction contract.

After Apple accepts the complete signed app, the pipeline staples the ticket,
checks it with `stapler` and Gatekeeper, and archives exactly `pacer.app` with
AppleDouble generation disabled. Tauri CLI **2.12.3** signs the final bytes with
`--app-version`; its globally signed trusted comment binds the intended version.
The generator validates that binding, the SHA-256, Apple Team ID and identifiers,
all three thin executable architectures, the thin Mach-O library, and signed `pacer-release.json`
compatibility metadata, including `nativeTransportAbi:1`. Missing or incompatible
libraries reject the package before execution. Production metadata has `fixture:false`.

Immutable GitHub release assets are:

- `desktop-pacer-VERSION-darwin-aarch64.app.tar.gz` and `.sig`
- `desktop-pacer-VERSION-darwin-x86_64.app.tar.gz` and `.sig`
- `desktop-release-VERSION.json`, with changelog notes and the release commit date

The `desktop-` prefix keeps existing CLI download patterns unchanged. Publication
creates assets only if absent and downloads them to verify exact bytes before
promotion. Existing different bytes are a conflict; there is no overwrite or
clobber path. Retry the promotion job with the **original** artifact set and
signatures. Rebuilding timestamps or resigning the same version can produce
conflicting bytes and is not a publishing retry.

The final feed commit is signed off and uses GitHub's
[`updateRefs` compare-and-swap](https://docs.github.com/en/graphql/reference/git#updaterefs)
with the observed old commit and `force:false`. A competing promotion cannot be
silently overwritten. A lost response is accepted only after rereading the exact
validated feed. Downgrades and changed same-version feeds are refused.

For a credential-free local release-pipeline exercise:

```sh
bun install --frozen-lockfile
(cd desktop && bun install --frozen-lockfile)
bun scripts/release/desktop-feed-fixture.ts --fixture .work/fixtures/desktop-release-new
```

The output directory must not exist. This explicit fixture driver builds
**data-only fixture archives**, creates disposable keys, uses the real pinned
Tauri signer, verifies signatures, publishes only to a local bare Git repository,
and checks an identical retry. It deletes its private keys. Its report marks
native app installation, Apple signing/notarization and remote publication as
`UNVERIFIED`; it cannot authorize the production publisher. Release dry-run
workflow dispatches run this fixture exercise as well. Native `ota-fixture`
manager scenarios are a separate live-harness exercise. Production validation
never substitutes fixture results for signed app evidence.
