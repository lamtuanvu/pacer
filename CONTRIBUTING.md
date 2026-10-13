# Contributing to pacer

Use Bun 1.4.2 or newer (the lockfile pins `@types/bun` and `bun-types` 1.4.2). From a checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The test script pins `TZ=Asia/Ho_Chi_Minh` because some tests depend on local dates and active-hour bins. Use `bun run test` for the consistent timezone.

When changing `orca-plugin/`, also run `bun run plugin:build` and include its generated assets. A test checks that the committed plugin bundle and embedded CLI assets are fresh. Re-run tests after rebuilding.

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

The preparation script updates `package.json`, rebuilds the bundled Orca plugin assets, and moves the Unreleased changelog content into a dated release section while leaving a fresh empty Unreleased section. Review and include the generated plugin files. Submit a PR with a DCO-signed commit titled `chore: release x.y.z`; merge it before tagging the resulting `main` commit:

```sh
git commit -s -m "chore: release x.y.z"
# After the PR is merged and your checkout is updated:
git tag -s vX.Y.Z -m "pacer X.Y.Z" # or -a for an annotated tag
git push origin vX.Y.Z
```

The tag must match `v` plus the package version. The release workflow verifies the tag, typechecks and tests, then builds macOS and Linux binaries for arm64 and x64 on their respective runners. Each runner smoke-tests its native binary. The publish job writes SHA256SUMS, manifest.json and latest.json, attests all four binaries, extracts the version's changelog notes, and uploads the seven flat assets to GitHub Releases. Workflow artifacts expire after one day. Stable releases become latest; versions containing `-` are marked prerelease and do not become latest.

The public installer works once the repository is public and the first release exists:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
gh attestation verify <file> -R lamtuanvu/pacer
```

`PACER_RELEASE_BASE` remains an override for testing or a separate release host. To test local artifacts, run `bun run release:host`, then `PACER_RELEASE_BASE="file://$PWD/dist/release" sh install.sh`.
