# Distribution

Every tagged release (`vX.Y.Z`, see [CONTRIBUTING](../CONTRIBUTING.md#releasing)) produces one set of binaries. Each channel below repackages those same binaries.

| Channel | Install | Built from |
| --- | --- | --- |
| GitHub Releases | download `pacer-<os>-<arch>` and check it against `SHA256SUMS` | `release.yml` |
| install.sh | `curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh \| sh` | GitHub Releases |
| npm | `npm install -g @lamtuanvu/pacer` | `bun run release:npm` |
| Homebrew | `brew install lamtuanvu/tap/pacer` | `bun run release:homebrew` |
| Orca plugin | marketplace source `https://github.com/lamtuanvu/pacer.git` at ref `main` | `orca-plugin` branch and `orca-plugin-v<version>` tags |

> Status: the npm and Homebrew generators exist, but `release.yml` does not run them yet. Until it does, publish those two channels by hand as described below.

Verify where a binary came from with `gh attestation verify pacer-<os>-<arch> -R lamtuanvu/pacer`.

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

After that, CI publishes without any npm token. Trusted publishing requires npm CLI 11.5.1+ and Node 22.14.0+, `permissions: id-token: write`, and a GitHub-hosted runner. Each package's `repository` field must match `github.com/lamtuanvu/pacer` exactly, including case ([npm docs](https://docs.npmjs.com/trusted-publishers), [provenance](https://docs.npmjs.com/generating-provenance-statements)).

## Homebrew

`bun run release:homebrew --manifest dist/release/<version>/manifest.json --out Formula/pacer.rb` writes a formula with per-OS, per-CPU release URLs and SHA-256 sums.

Tap setup:

1. Create the public repo `lamtuanvu/homebrew-tap`.
2. Create a fine-grained token with **Contents: read and write** on `lamtuanvu/homebrew-tap` only.
3. Store it as the `HOMEBREW_TAP_TOKEN` Actions secret in `lamtuanvu/pacer`.

The release workflow commits `Formula/pacer.rb` to the tap and skips that step while the secret is missing.

## Orca plugin

On each release, `release.yml` publishes `orca-plugin/dist` as the root of the `orca-plugin` branch and tags it `orca-plugin-v<version>`. `orca-marketplace.json` on `main` points at that tag; `bun run release:prepare` bumps it. Users can add the marketplace or install `https://github.com/lamtuanvu/pacer.git#orca-plugin-v<version>` directly. The pacer CLI must be installed as well.
