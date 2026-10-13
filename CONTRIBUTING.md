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
