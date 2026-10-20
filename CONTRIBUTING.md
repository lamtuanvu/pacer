# Contributing to pacer

Use Bun 1.4.2 or newer (the lockfile pins `@types/bun` and `bun-types` 1.4.2). From a checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The test script pins `TZ=Asia/Ho_Chi_Minh` because some tests depend on local dates and active-hour bins. Use `bun run test` for the consistent timezone.

When changing `app/`, also run `bun run app:build` and include its generated assets. Use the exact Bun version pinned in `.github/workflows/ci.yml` (currently 1.4.2) to generate and validate these assets: compiler output can differ between patch releases. A test checks that the embedded app assets are fresh. Re-run tests after rebuilding.

Regenerate client protocol docs with `bun run protocol:doc` and plugin protocol docs with `bun run plugin:protocol`.

## Rust

The Rust host is built with the Cargo workspace in this repository. Install [rustup](https://rustup.rs) and let it apply the toolchain that `rust-toolchain.toml` pins (1.99.0):

```sh
cargo build --workspace
cargo test --workspace
cargo xtask gen
cargo xtask loc
cargo xtask deps
```

Follow the Rust code rules in [.project/rules/rust.md](.project/rules/rust.md) and the crate structure and size rules in [.project/rules/rust-crates.md](.project/rules/rust-crates.md).

Discuss significant changes in an issue first. Keep pull requests focused, explain the behavior changed, link relevant issues and describe validation. Use a Conventional Commit PR title, for example `fix: handle missing usage readings` or `docs: clarify executor setup`. PRs are squash merged; the PR title becomes the commit on `main`.

## Developer Certificate of Origin

Every contribution commit must have a DCO sign-off:

```sh
git commit -s -m "docs: improve setup instructions"
```

This adds a `Signed-off-by` trailer using your Git identity. It certifies that you have the right to submit the contribution under the project's license, as described in the [Developer Certificate of Origin](https://developercertificate.org). A sign-off is a certification, not a cryptographic signature.

AI-assisted contributions are welcome. The human submitter is responsible for the contribution's correctness, licensing, security and tests. Agents must follow [AGENTS.md](AGENTS.md), including the rules for working documents and public files.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [Security](SECURITY.md), not public issues. See [Support](SUPPORT.md) for questions and [Governance](GOVERNANCE.md) for decisions.

## Releasing

Keep `CHANGELOG.md` Unreleased up to date in each PR. To release, open **Actions → Prepare release → Run workflow** on `main` and pick a bump:

- `auto` (default) reads the commit titles since the last tag: a breaking change (`feat!:` or any `type!:`) bumps the minor version during 0.x and the major version from 1.0; `feat` bumps the minor version; `fix`, `perf` and `revert` bump the patch version. `docs`, `test`, `chore`, `ci` and similar titles alone don't release anything.
- `patch`, `minor` or `major` forces that bump.

The workflow then does the rest:

1. `scripts/release/next-version.ts` picks the version and refuses an empty Unreleased section.
2. `bun run release:prepare <version>` updates `package.json`, the desktop app versions and the embedded app assets, and moves Unreleased into a dated section.
3. It commits `chore: release <version>` (DCO-signed) on `release/v<version>` and opens the PR. CI runs the full suite; the PR needs no UI evidence manifest because its only UI-scoped changes are version strings, which CI checks.
4. It runs the release dry run on that branch: every platform builds (including production-signed macOS apps when `PACER_DESKTOP_RELEASE_ENABLED=true`), npm publishes with `--dry-run` and the Homebrew formula is checked, with nothing published.
5. When the dry run passes, it turns on auto-merge. If the dry run fails, it comments on the PR and stops; fix `main`, close the PR, delete the branch and run it again.
6. When the PR merges, **Release tag** tags the merge commit `v<version>` and the tag runs `release.yml`, which publishes.

Only one release runs at a time, and a version whose tag already exists is never re-tagged.

### One-time setup: `RELEASE_TOKEN`

GitHub doesn't run workflows for pushes and PRs made with the built-in `GITHUB_TOKEN`, so the release PR and tag use a fine-grained personal access token:

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
2. Resource owner: `lamtuanvu`; repository access: only `lamtuanvu/pacer`; pick an expiry.
3. Repository permissions: **Contents**, **Pull requests** and **Workflows**: Read and write. Metadata stays Read.
4. Save it as the repository secret `RELEASE_TOKEN` (Settings → Secrets and variables → Actions), or run `gh secret set RELEASE_TOKEN -R lamtuanvu/pacer` and paste it.

Renew it before it expires; Prepare release and Release tag fail with a clear error without it.

### Manual fallback

Without the token, release by hand: `bun run release:prepare <x.y.z>`, a DCO-signed PR titled `chore: release x.y.z`, `gh workflow run release.yml -f version=<x.y.z> -f dry_run=true`, then after merging tag the merge commit with `git tag -a vX.Y.Z -m "pacer X.Y.Z"` and `git push origin vX.Y.Z`. If you merge a `chore: release` PR by hand while the token is set, Release tag still tags it. A dispatch of `release.yml` with `dry_run=false` is rejected; tags are the only release trigger.

The tag must match `v` plus the package version. The release workflow verifies the tag, typechecks and tests, then builds macOS and Linux binaries for arm64 and x64 on their respective runners. Each runner smoke-tests its native binary. The publish job writes SHA256SUMS, manifest.json and latest.json, attests all four binaries, extracts the version's changelog notes, and uploads the seven flat assets to GitHub Releases. Workflow artifacts expire after one day. Stable releases become latest; versions containing `-` are marked prerelease and do not become latest.

After the GitHub release is created, the npm job publishes all five packages using trusted publishing, skipping versions already published. Enable the repository variable `NPM_TRUSTED_PUBLISHING=true` only after the one-time npm bootstrap and trusted-publisher setup. The Homebrew job updates `lamtuanvu/homebrew-tap` on stable releases when the `HOMEBREW_TAP_TOKEN` secret is set, and skips unchanged formulas. See [distribution](docs/distribution.md) for setup.

Artifact attestations require a public repository (or GitHub Enterprise), so real releases happen after this repository is public.

The public installer works once the repository is public and the first release exists:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
gh attestation verify <file> -R lamtuanvu/pacer
```

`PACER_RELEASE_BASE` remains an override for testing or a separate release host. To test local artifacts, run `bun run release:host`, then `PACER_RELEASE_BASE="file://$PWD/dist/release" sh install.sh`.
