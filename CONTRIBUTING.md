# Contributing to pacer

Use Bun 1.4.2 or newer (the lockfile pins `@types/bun` and `bun-types` 1.4.2). From a checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The test script pins `TZ=Asia/Ho_Chi_Minh` because some tests depend on local dates and active-hour bins. Use `bun run test` for the consistent timezone.

When changing `app/`, also run `bun run app:build` and include its generated assets. Use the exact Bun version pinned in `.github/workflows/ci.yml` (currently 1.4.2) to generate and validate these assets: compiler output can differ between patch releases. A test checks that the embedded app assets are fresh. Re-run tests after rebuilding.

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

Start from an up-to-date checkout of `main`. Prepare a stable version greater than the current version:

```sh
bun run release:prepare <x.y.z>
bun run typecheck
bun run test
```

The preparation script updates `package.json` and the desktop app versions, rebuilds the pacer app assets, and moves the Unreleased changelog content into a dated release section while leaving a fresh empty Unreleased section. Review and include the generated app files. Submit a PR with a DCO-signed commit titled `chore: release x.y.z`; merge it before tagging the resulting `main` commit. Validate the prepared version through a dry run before releasing:

```sh
gh workflow run release.yml -f version=<x.y.z> -f dry_run=true
```

The dry run builds all platforms, prints metadata and release notes, runs npm publication with `--dry-run`, and validates the generated Homebrew formula with `ruby -c`. It does not publish or push remotely. A dispatch with `dry_run=false` is rejected; tags are the only release trigger.

After reviewing the dry run, tag the merged commit:

```sh
git commit -s -m "chore: release x.y.z"
# After the PR is merged and your checkout is updated:
git tag -s vX.Y.Z -m "pacer X.Y.Z" # or -a for an annotated tag
git push origin vX.Y.Z
```

The tag must match `v` plus the package version. The release workflow verifies the tag, typechecks and tests, then builds macOS and Linux binaries for arm64 and x64 on their respective runners. Each runner smoke-tests its native binary. The publish job writes SHA256SUMS, manifest.json and latest.json, attests all four binaries, extracts the version's changelog notes, and uploads the seven flat assets to GitHub Releases. Workflow artifacts expire after one day. Stable releases become latest; versions containing `-` are marked prerelease and do not become latest.

After the GitHub release is created, the npm job publishes all five packages using trusted publishing, skipping versions already published. Enable the repository variable `NPM_TRUSTED_PUBLISHING=true` only after the one-time npm bootstrap and trusted-publisher setup. The Homebrew job updates `lamtuanvu/homebrew-tap` on stable releases when the `HOMEBREW_TAP_TOKEN` secret is set, and skips unchanged formulas. See [distribution](docs/distribution.md) for setup.

Artifact attestations require a public repository (or GitHub Enterprise), so real releases happen after this repository is public.

The public installer works once the repository is public and the first release exists:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
gh attestation verify <file> -R lamtuanvu/pacer
```

`PACER_RELEASE_BASE` remains an override for testing or a separate release host. To test local artifacts, run `bun run release:host`, then `PACER_RELEASE_BASE="file://$PWD/dist/release" sh install.sh`.
