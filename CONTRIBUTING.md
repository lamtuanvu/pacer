# Contributing to pacer

Use Bun 1.4.2 or newer (the lockfile pins `@types/bun` and `bun-types` 1.4.2). From a checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The test script pins `TZ=Asia/Ho_Chi_Minh` because some tests depend on local dates and active-hour bins. Use `bun run test` for the consistent timezone and local service isolation; see [test isolation](docs/testing/test-isolation.md).

When changing `app/`, also run `bun run app:build` and include its generated assets. Use the exact Bun version pinned in `.github/workflows/ci.yml` (currently 1.4.2) to generate and validate these assets: compiler output can differ between patch releases. A test checks that the embedded app assets are fresh. Re-run tests after rebuilding.

Regenerate client protocol docs with `bun run protocol:doc` and plugin protocol docs with `bun run plugin:protocol`.

For UI-affecting changes, follow the [UI review readiness procedure](.project/rules/ui.md#ui-review-readiness-procedure). `bun run ui:ready --pr <number> --ready` checks current PR evidence metadata using the same validator as CI; `ui:check` alone checks source when no GitHub event is supplied.

## Rust

The Rust host is built with the Cargo workspace in this repository. Install [rustup](https://rustup.rs) and let it apply the toolchain that `rust-toolchain.toml` pins (1.99.0):

```sh
cargo build --workspace
cargo test --workspace
cargo xtask gen
cargo xtask loc
cargo xtask deps
```

Follow the Rust code rules in [.project/rules/rust.md](.project/rules/rust.md) and the crate structure and size rules in [.project/rules/rust-crates.md](.project/rules/rust-crates.md). The front door (`cargo run -p pacer`) execs the bun-compiled core for commands that are not yet native; to run it against the source core instead, point `PACER_CORE_ARGV` at it, e.g. `PACER_CORE_ARGV='["bun","<repo>/src/cli.ts"]' cargo run -p pacer -- <command>`.

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

Keep `CHANGELOG.md` Unreleased up to date in each PR when you can. To release, open **Actions → Prepare release → Run workflow** on `main` and pick a bump:

- `auto` (default) reads the commit titles since the last tag: a breaking change (`feat!:` or any `type!:`) bumps the minor version during 0.x and the major version from 1.0; `feat` bumps the minor version; `fix`, `perf` and `revert` bump the patch version. `docs`, `test`, `chore`, `ci` and similar titles alone don't release anything.
- `patch`, `minor` or `major` forces that bump when commits exist, even if their titles do not select an automatic release.

Prepare keeps authored Unreleased notes as written. If Unreleased is empty, it builds notes from commit titles since the current version tag, groups them under Keep a Changelog headings, and redacts email addresses and local machine paths. Generated notes are published with the tag; there is no release PR to review them in first. Write the notes in Unreleased beforehand if they need care, or edit the GitHub release afterwards; commit titles may lack context that a hand-written entry would provide. With no commits since the tag, Prepare stops without creating empty release notes.

The workflow then does the rest, all on one commit:

1. It pins the commit to release: `main`'s head when the run starts, or the commit you enter (it must be on `main`). Nothing merged to `main` afterwards affects this release.
2. It picks the version. If the pinned commit's `package.json` version has no tag yet (its bump merged earlier), that version is released as is. Otherwise `scripts/release/next-version.ts` picks the next version and requires at least one commit since the tag.
3. For a new version, `bun run release:prepare <version>` updates `package.json`, the desktop app versions and the embedded app assets, and moves Unreleased into a dated section. It commits `chore: release <version>` (DCO-signed) on top of the pinned commit. That commit is not pushed to `main`.
4. It tags that commit `v<version>` and pushes only the tag. The tag runs `release.yml`, which typechecks and tests, builds every platform, requires CI's full suite on both OSes for the tagged commit (dispatching CI on the tag when none has run) and publishes. All of it runs from the tag.
5. It opens a `chore: release <version>` bookkeeping PR from `release/v<version>` to bring the bump to `main`, with auto-merge on. It's an ordinary PR under the usual required checks. The release doesn't wait for it, and merging it tags nothing.

Only one release runs at a time, and a version whose tag already exists is never re-tagged.

### Plugin SDK registry publishing

Plugin SDK releases require the repository Actions secret `CARGO_REGISTRY_TOKEN`, created on crates.io with permission to publish `pacer-plugin-protocol`, `pacer-plugin-decision-protocol`, `pacer-plugin-agent-session-protocol` and `pacer-plugin` (including their first publication). Never put the token in a file or PR. Their crate versions are independent of the application version and are bumped by hand when the SDK or plugin protocol changes. Tag releases package and publish the protocol crates before the SDK. For an existing version, the registry archive's checksum is verified, then its source and metadata are compared to the local package; generated VCS provenance and Cargo.lock are excluded from that comparison so unrelated application releases do not require SDK version bumps. Different library inputs require a new crate version.

Run `cargo publish --dry-run -p <crate>` for each protocol crate before publishing. The SDK's first registry dry run requires those protocol versions to be published and indexed; workspace tests verify its path dependency beforehand. `bun scripts/release/crates.ts` runs package/dry-run checks without uploading; `--publish` is reserved for the tag workflow.

### One-time setup: `RELEASE_TOKEN`

GitHub doesn't run workflows for pushes and PRs made with the built-in `GITHUB_TOKEN`, so the release tag and bookkeeping PR use a fine-grained personal access token:

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
2. Resource owner: `lamtuanvu`; repository access: only `lamtuanvu/pacer`; pick an expiry.
3. Repository permissions: **Contents**, **Pull requests** and **Workflows**: Read and write. Metadata stays Read.
4. Save it as the repository secret `RELEASE_TOKEN` (Settings → Secrets and variables → Actions), or run `gh secret set RELEASE_TOKEN -R lamtuanvu/pacer` and paste it.

Renew it before it expires; Prepare release fails with a clear error without it.

### Nightly builds

Nightlies are signed prereleases of a `main` commit, published to the `nightly` channel ([distribution](docs/distribution.md#nightly-builds)). To run one by hand, open **Actions → Nightly → Run workflow** on `main`:

1. Run it with `dry_run` checked first. It selects the commit, waits for CI evidence (dispatching CI on `main` when the commit has no full-suite run), picks the version and stamps it, but pushes no tag.
2. Then run it again without `dry_run`. Leave `sha` empty to build `main`'s head, or enter a commit on `main`. The pushed `v<version>` tag (for example `v0.16.0-nightly.202611171700`) runs `release.yml`.

Nightly uses the same `RELEASE_TOKEN` as Prepare release. A nightly never adds commits to `main` and never touches `CHANGELOG.md`. A failed nightly is fixed like a failed release: rerun the failed jobs of the **Release** run for that tag, or run Nightly again for a new version. The scheduled midnight run stays off until the first manual nightly has succeeded.

### Interrupted releases

A tag is the whole release. If publication fails, fix the cause (often a flaky job), then rerun the failed jobs of the **Release** run for that tag; tags are never moved. If the tagged commit itself is broken, release a new version from a fixed commit. If Prepare stops before pushing the tag, just run it again. If the tag was pushed but the bookkeeping PR wasn't opened, don't rerun Prepare (the tag exists). Cherry-pick the tagged `chore: release` commit onto `main` in an ordinary PR instead.

### Manual fallback

Without the token, release by hand. On a commit of `main` whose `package.json` holds an untagged version with a CHANGELOG section (run `bun run release:prepare <x.y.z>` and commit it on top otherwise), run `git tag -a vX.Y.Z -m "pacer X.Y.Z"` and `git push origin vX.Y.Z`. Bring a bump commit to `main` with an ordinary PR afterwards. To check a build without publishing, use `gh workflow run release.yml --ref <branch> -f version=<x.y.z> -f dry_run=true`. A dispatch with `dry_run=false` is rejected; tags are the only release trigger.

The tag must match `v` plus the package version. The release workflow verifies the tag, typechecks and tests, then builds macOS and Linux binaries for arm64 and x64 on their respective runners. Each runner smoke-tests its native binary. The publish job writes SHA256SUMS, manifest.json and latest.json, attests all four binaries, extracts the version's changelog notes, and uploads the seven flat assets to GitHub Releases. Workflow artifacts expire after one day. Stable releases become latest; versions containing `-` are marked prerelease and do not become latest.

After the GitHub release is created, the npm job publishes all five packages using trusted publishing, skipping versions already published. Enable the repository variable `NPM_TRUSTED_PUBLISHING=true` only after the one-time npm bootstrap and trusted-publisher setup. The Homebrew job updates `lamtuanvu/homebrew-tap` on stable releases when the `HOMEBREW_TAP_TOKEN` secret is set, and skips unchanged formulas. See [distribution](docs/distribution.md) for setup.

Artifact attestations require a public repository (or GitHub Enterprise), so real releases happen after this repository is public.

The public installer works once the repository is public and the first release exists:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
gh attestation verify <file> -R lamtuanvu/pacer
```

`PACER_RELEASE_BASE` remains an override for testing or a separate release host. To test local artifacts, run `bun run release:host`, then `PACER_RELEASE_BASE="file://$PWD/dist/release" sh install.sh`.
