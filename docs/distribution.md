# Distribution

Every tagged release (`vX.Y.Z`, see [CONTRIBUTING](../CONTRIBUTING.md#releasing)) produces one set of binaries. Each channel below repackages those same binaries.

| Channel | Install | Built from |
| --- | --- | --- |
| GitHub Releases | download `pacer-<os>-<arch>` and check it against `SHA256SUMS` | `release.yml` |
| Desktop app | download `pacer-<version>-<os>-<arch>-unsigned.dmg`, `.AppImage` or `.deb`; see [desktop](../desktop/README.md) | `release.yml` |
| install.sh | `curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh \| sh` | GitHub Releases |
| npm | `npm install -g @lamtuanvu/pacer` | `bun run release:npm` |
| Homebrew | `brew install lamtuanvu/tap/pacer` | `bun run release:homebrew` |

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

## Dry-run release validation

From a checkout whose package version, app assets and changelog are prepared for the version, run:

```sh
gh workflow run release.yml -f version=<x.y.z> -f dry_run=true
```

The workflow checks the input against `package.json`, builds and smoke-tests all four binaries, writes metadata, and prints asset SHA-256 hashes and release notes. npm packages are generated from workflow artifacts and checked with `npm publish --dry-run` regardless of `NPM_TRUSTED_PUBLISHING`. Homebrew generates and prints its formula and checks it with `ruby -c` without needing the tap token.

Dry runs skip attestations, GitHub release uploads, npm publication and tap pushes. Build artifacts expire after one day. A dispatch with `dry_run=false` is refused; only version tags can publish releases.
