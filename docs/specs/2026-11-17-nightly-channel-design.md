# Nightly update channel

Date: 2026-11-17

Status: Proposed design. Accepted when the maintainer merges it.

Context: [ADR 0001 desktop OTA](../decisions/0001-desktop-ota.md), [ADR 0021 single installation owner](../decisions/0021-single-installation-owner.md), [desktop updates](../desktop-updates.md), [distribution](../distribution.md), release rules REL-2, REL-3, REL-5 and REL-8 in `.project/rules/release.md`.

## Goal

Users who opt in receive a signed build of the latest `main` every night, through the same update flows they already use. Three parts:

1. **Pipeline:** every midnight, build `origin/main` into a signed, immutable nightly prerelease. The maintainer can also trigger it by hand.
2. **Infrastructure:** nightly feeds next to the stable ones, with the same compare-and-swap, no-downgrade and both-architecture rules.
3. **Clients:** the desktop app, the standalone CLI and npm installs can subscribe to the nightly channel. They then see and are offered nightly updates.

## Non-goals

- Downgrading from nightly to stable. Switching back to stable waits until a stable release is newer than the installed nightly.
- Homebrew nightlies (no channel mechanism) and crates.io nightlies.
- A separate host outside GitHub Releases.
- Any change to how stable releases are prepared, tagged or published.

## Versions and tags

A nightly version is `<next-minor>-nightly.<YYYYMMDDHHmm>`:

- `<next-minor>` is the minor after the latest stable `vX.Y.Z` tag (`0.15.1` → `0.16.0`).
- `<YYYYMMDDHHmm>` is the UTC build start time as a single numeric identifier. It is 12 digits with no leading zero, so it is valid SemVer and sorts in time order. Manual runs on the same day get distinct versions.

Example: `0.16.0-nightly.202611171700`, tag `v0.16.0-nightly.202611171700`.

Properties:

- Every nightly is newer than the current stable and older than the next minor stable (`0.16.0`), so nightly users move to the next stable release when it ships.
- If the next stable release is a patch (`0.15.2`), nightly users already have a newer version and are not offered it. That is correct: they are ahead.
- If the next stable release is a major (`1.0.0`), nightly users move to it, and the following nightly is `1.1.0-nightly.*`.
- Tags are never moved or reused (consistent with REL-2). A rerun of a failed nightly uses the same tag. A new manual run gets a new timestamp.

The tagged commit is a commit that is never merged into `main`. Its parent is the selected `main` commit, and it only stamps the nightly version into `package.json`, `desktop/src-tauri/Cargo.toml`, `tauri.conf.json` and the matching lockfile entry, using the same bump code as `release:prepare` (REL-8). `release.yml` therefore keeps its "tag equals `package.json` version" check unchanged. `main` never receives nightly version commits.

## Pipeline

A new workflow, `.github/workflows/nightly.yml`:

- **Triggers:** `schedule` at `0 17 * * *` (00:00 UTC+7, the maintainer's midnight), and `workflow_dispatch` with an optional `sha` input (default: `main` HEAD when the run starts).
- **Skip rule:** a scheduled run exits successfully without building when the selected `main` SHA equals the parent of the newest nightly tag. A manual run always builds.
- **CI gate:** the selected `main` SHA must have a green full CI suite on both OSes. A scheduled run waits for an in-progress CI run on that SHA, with a bounded timeout. If CI fails, the night is skipped and reported.
- **Tag:** compute the version, create the stamp commit, push the annotated tag with the existing release token (the same mechanism `release-prepare.yml` uses), which triggers `release.yml`.
- **Concurrency:** one nightly at a time (`concurrency: nightly`, no cancellation of an in-progress run).

`release.yml` derives the channel from the version. A version matching `^\d+\.\d+\.\d+-nightly\.\d{12}$` is `nightly`. Any other version containing `-` stays a regular prerelease, and a version with no `-` is stable. For `nightly`:

- **Verify:** the CI-suite requirement is evaluated against the stamp commit's parent (the `main` commit), because the stamp commit changes only version fields. The verify job asserts this: the diff between parent and tag touches only the version files.
- **Build:** the full matrix from REL-3 (darwin and linux, arm64 and x64), native smoke tests, checksums and provenance attestations, all unchanged.
- **GitHub Release:** `--prerelease --latest=false`. Release notes are the commit titles between the previous nightly's parent and this one, truncated to the desktop feed's notes limit.
- **npm:** publish with dist-tag `nightly` (not `next`; see the REL-5 amendment).
- **crates.io:** skipped.
- **Desktop:** build, sign and notarize as for stable (the signing identity and updater key are shared), validate both architectures, then compare-and-swap `nightly.json`.
- **CLI feed:** compare-and-swap `cli-nightly.json`.
- **Feed order:** both feeds advance only after every required artifact has been published and validated. A failure on any architecture leaves both feeds unchanged.
- **Failure reporting:** a failed scheduled or manual nightly opens or updates a single issue labelled `nightly-failure`, linking the run. The next successful nightly closes it.

**Retention:** a `nightly-prune` job (after a successful publish, and weekly) deletes nightly GitHub Releases and tags older than 14 days. It always keeps the newest 3, and never deletes the version `nightly.json` or `cli-nightly.json` currently references. npm versions are not unpublished; the `nightly` dist-tag simply moves.

## Feeds

All feeds live on the existing `desktop-updates` branch and use the existing `DesktopPublisher` compare-and-swap.

| Feed | Accepts | Schema | Consumers |
| --- | --- | --- | --- |
| `stable.json` | `X.Y.Z` only (unchanged) | existing desktop feed | desktop, both channels |
| `nightly.json` | `X.Y.Z-nightly.N` only | identical to `stable.json` | desktop, nightly channel |
| `cli-nightly.json` | `X.Y.Z-nightly.N` only | identical to the CLI's `latest.json` | CLI and service, nightly channel |

The stable CLI feed stays `releases/latest/download/latest.json`. GitHub's "latest" release already excludes prereleases, so nightlies never reach stable CLI users.

Per-feed rules in `scripts/release/desktop-feed.ts`:

- `stableVersion()` keeps guarding `stable.json`. A new `nightlyVersion()` guards `nightly.json` and `cli-nightly.json`. Each feed rejects the other channel's versions.
- No downgrades within a feed. A same-version, different-content publish is an immutable-version conflict, as today.
- Asset URLs in `nightly.json` point at the immutable `v<nightly>` release assets, using the existing asset names with the nightly version.

## Clients

### Channel setting

The channel is `stable` (default) or `nightly`. It is stored by the installation's owner (ADR 0021):

- **Desktop owner:** the service stores it in its desktop-update state. `desktop.update.configure` gains an additive `channel` field (protocol v3, additive), and status reports the effective channel. Settings → Updates shows a Stable/Nightly control. Choosing Nightly shows a one-line warning that nightly builds are untested daily snapshots of `main`.
- **CLI owner:** `pacer update --channel nightly|stable` stores it in the CLI update state next to `update-check.json`, and `pacer update --channel` with no value prints the current channel. The update check and `pacer update` honor it. When the desktop owns the installation, `pacer update` already defers to the app, and so does `--channel`.

Changing the channel triggers an immediate update check.

### Selecting an update

- **Stable:** read `stable.json` (desktop) or `latest.json` (CLI). Offer the update only if it is newer than the installed version. A nightly install that switches to stable therefore waits until stable passes it.
- **Nightly:** read both the stable and nightly feeds and pick the newest valid entry. If one feed is unreachable or invalid, use the other and report the failed feed in update status. The update is offered if it is newer than the installed version.

### Desktop trust

ADR 0001 requires that runtime input cannot select the feed. Both feed URLs are compile-time constants in `desktop/src-tauri/src/ota/trust.rs` (`STABLE_FEED`, a new `NIGHTLY_FEED`). The channel is an enum that chooses among compiled constants, never a URL. The updater public key, signer pinning, bundle identity, size limits and both-architecture validation are identical for both channels. Fixture builds keep their own compiled fixture feeds.

The download, wait-for-work, "Restart to update", recovery and helper transaction are unchanged.

### CLI parity

The TypeScript update path (`src/update/`) and the Rust update crate (`crates/update`) change together: channel storage, `cli-nightly.json` fetch, newest-of-both selection and the `--channel` option. Parity tests cover both. `normalize_base` overrides keep working and point at a base containing `cli-nightly.json` for the nightly channel.

### npm

`npm install -g @lamtuanvu/pacer@nightly` installs the newest nightly. A CLI installed from npm on the nightly channel reports updates and directs the user to that command, the same way the stable channel uses `@latest` today.

## Governance changes

- **ADR 0028, nightly update channel:** records the channel, the version scheme, the compiled feed constants, and the no-downgrade rule when leaving nightly. It extends ADR 0001's "stable releases" scope to signed nightly prereleases.
- **REL-5 amendment:** versions containing `-` are prereleases. Nightly versions (`-nightly.N`) use npm dist-tag `nightly`; other prereleases keep `next`.
- **New REL-9:** nightly builds are produced from a green `main` commit as immutable, never-moved tags on a stamp commit that is never merged into `main`. They publish only to the nightly feeds and dist-tag, and are pruned after 14 days.
- **Docs:** `docs/distribution.md` (nightly section), `docs/desktop-updates.md` (channel control), `CONTRIBUTING.md` (manual nightly trigger).

## Error handling

| Situation | Behavior |
| --- | --- |
| No new commits since the last nightly (scheduled run) | Skip with a notice. No tag, no issue. |
| CI red or timed out on the selected SHA | Skip the night and open or update the `nightly-failure` issue. |
| One architecture fails to build, sign or validate | No feed advances. The prerelease may exist with partial assets. Issue opened. A rerun on the same tag completes it. |
| Feed compare-and-swap conflict | Fail the publish step. Rerunning rereads the feed. |
| Client cannot reach `nightly.json` | Fall back to `stable.json` and show the feed error in update status. |
| User switches nightly → stable | No change until a newer stable release exists. Status explains this. |

## Testing

- **Unit:** version computation (next minor, timestamp formatting, no leading zero, ordering against stable), the channel classifier in `release.yml`'s verify script, `nightlyVersion()` and cross-channel rejection, newest-of-both selection, fallback when one feed fails, and no offer when on nightly with the stable channel selected.
- **Release fixtures:** extend `scripts/release/desktop-feed-fixture.ts` with a nightly promotion, an immutable retry and cross-channel rejection. PRs that touch release files dry-run the nightly path, including the stamp-commit diff check.
- **Rust and TS parity:** CLI channel storage and selection in `crates/update` tests and `test/update-*.test.ts`.
- **Live validation (CT-11):** with the fixture bundle, a temporary `PACER_HOME` and fixture feeds, exercise switching to nightly, being offered a nightly over stable, moving from nightly to the next stable release, and switching back to stable without a downgrade, through the desktop Settings, `pacer desktop-update` and `pacer update --channel`. Production signing and both-architecture publication are reported UNVERIFIED until the first real nightly runs.
- **First real run:** a manual `workflow_dispatch` nightly before enabling the schedule, with evidence attached to the PR.

## Delivery phases

Each phase is a separate PR.

1. **Governance:** ADR 0028, the REL-5 amendment, REL-9 and this spec.
2. **Pipeline:** `nightly.yml`, version computation, stamp commit and tag, the `release.yml` channel classifier, npm `nightly` dist-tag, GitHub prerelease and pruning. No feeds yet.
3. **Feeds:** `nightlyVersion()`, `nightly.json` and `cli-nightly.json` publishing, and fixture coverage.
4. **Desktop client:** `NIGHTLY_FEED` constant, the channel in service update state, `desktop.update.configure`, newest-of-both selection and the Settings control.
5. **CLI client:** `pacer update --channel` in TS and Rust, `cli-nightly.json` and npm guidance.
6. **Enable:** first manual nightly, then turn on the schedule.
