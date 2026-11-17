# Nightly update channel

Date: 2026-11-17

Status: Proposed. Accepted when the maintainer merges it.

Context: [ADR 0001](0001-desktop-ota.md), [ADR 0021](0021-single-installation-owner.md), [nightly channel design](../specs/2026-11-17-nightly-channel-design.md), [desktop updates](../desktop-updates.md), [distribution](../distribution.md), release rules REL-2, REL-3, REL-5, REL-8 and REL-9 in `.project/rules/release.md`.

Pacer ships only stable releases. Changes merged to `main` reach users when the maintainer runs **Prepare release**, which can be days or weeks later. Users who want to try fixes early have to build from source, and the desktop app has no way to receive anything but a stable build. ADR 0001 limits desktop OTA to stable releases, and its native updater accepts only `X.Y.Z` versions, both in the feed and for the installed app.

## Decision

**Signed nightly builds of `main` are published as immutable prereleases, and installations opt in with one setting, `update_channel`.**

### Versions and tags

- A nightly version is `<next-minor>-nightly.<YYYYMMDDHHmm>`: the minor after the latest stable `vX.Y.Z` tag, and the UTC build start time as one 12-digit numeric identifier. Example: `0.16.0-nightly.202611171700`.
- Every nightly is newer than the current stable and older than the next minor stable, so nightly users move to the next stable release when it ships. A later stable patch is older than an installed nightly and is not offered.
- `nightly.yml` selects a `main` commit whose full CI suite is green on both OSes. It stamps the version onto a commit whose parent is that `main` commit, writing only the version files. That commit is never merged into `main`. It then pushes the annotated tag `v<version>`, which runs the existing `release.yml`.
- Tags are never moved or reused (REL-2). A failed nightly is rerun on the same tag.

### Pipeline and publication

- `release.yml` derives the channel from the version: `X.Y.Z-nightly.N` is nightly, any other version containing `-` is a regular prerelease, and `X.Y.Z` is stable.
- Nightlies publish a GitHub prerelease (never "latest"), npm with dist-tag `nightly`, and the `nightly.json` and `cli-nightly.json` feeds on the `desktop-updates` branch. They never publish to crates.io, Homebrew, `stable.json` or the stable CLI feed.
- **The both-architecture gate and signing are identical to stable.** The full REL-3 matrix, smoke tests, checksums and provenance attestations, Developer ID or interim self-signed code signing, notarization where stable has it, and the Ed25519 updater signature all apply unchanged. Feeds advance only after every required artifact is published and validated. A failure on any architecture leaves both nightly feeds unchanged.
- Nightlies older than 14 days are pruned, except the newest 3 and any version a feed references.

### Feeds

| Feed | Accepts | Consumers |
| --- | --- | --- |
| `stable.json` | `X.Y.Z` only (unchanged) | desktop, both channels |
| `nightly.json` | `X.Y.Z-nightly.N` only, same schema as `stable.json` | desktop, nightly channel |
| `cli-nightly.json` | `X.Y.Z-nightly.N` only, same schema as the CLI's `latest.json` | CLI and service, nightly channel |

Each feed rejects the other channel's versions. Feeds keep the existing compare-and-swap, immutable-version and no-downgrade rules.

### Channel setting

- The channel is one installation-wide strategy key, `update_channel`, with exactly two values: `stable` (default) and `nightly`. The desktop Settings control, `pacer config set update_channel`, `pacer update`, the service's `update.check` and `pacer status` all use it.
- On stable, a client reads only the stable feed. On nightly, it reads both feeds and takes the newest valid entry. If one feed fails, it uses the other and reports the failed feed.
- **No downgrade when leaving nightly.** Switching back to stable offers nothing until a stable release is newer than the installed nightly. No client or feed ever installs an older version.

### Desktop trust

This ADR extends ADR 0001's "stable releases" scope to signed nightly prereleases. ADR 0001's rule that runtime input cannot select the feed still holds:

- **Nightly feed URLs are compiled constants, and the channel is an enum.** `STABLE_FEED` and a new `NIGHTLY_FEED` are compile-time constants in the desktop's OTA trust module. The adapter's `check` command gains a `channel` field, `stable` or `nightly`, which chooses among those constants and never carries a URL. Fixture builds read the matching feed under their compiled fixture root.
- **The native updater accepts `X.Y.Z-nightly.N` installed versions.** It accepts `X.Y.Z` and `X.Y.Z-nightly.N`, and nothing else, for the installed version and for `nightly.json` entries. `stable.json` entries must still be `X.Y.Z`. The newer-only comparison uses SemVer precedence.
- The updater public key, signer pinning, bundle identity, artifact URL pinning (`releases/download/v<version>/…`), size limits and both-architecture validation are identical for both channels. Download, wait-for-work, restart, recovery and the helper transaction are unchanged.

## Consequences

Users can opt into daily builds through the update flows they already use, and the maintainer gets earlier feedback on `main`. Nightly builds run the same build and signing path as stable, so every night also exercises the release pipeline.

The cost is a second publication path to maintain and review. `release.yml` gains channel branches, and the feed scripts, the TypeScript and Rust update checks and the native updater all gain a channel. A user who leaves nightly keeps the installed nightly until a newer stable ships. Settings explains this next to the control. Homebrew and crates.io users have no nightly channel. Production signing and both-architecture publication for nightlies stay UNVERIFIED until the first real nightly runs.

## Alternatives considered

- **A rolling `nightly` tag moved to each new build.** Moving tags violates REL-2, breaks immutable artifact URLs that feeds and the updater pin, and makes a failed build impossible to rerun or audit.
- **A separate host for nightly artifacts.** It would need its own signing trust, retention and availability, and a second compiled host in the desktop's trust module. GitHub Releases and the `desktop-updates` branch already provide immutable assets and compare-and-swap feeds.
- **Explicit downgrade when switching back to stable.** Downgrades can cross state or schema changes that the older build cannot read, and they would weaken the no-downgrade guarantee that protects every channel. Waiting for the next stable release is safe and usually short.
