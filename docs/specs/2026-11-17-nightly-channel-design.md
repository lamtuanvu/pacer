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

The tagged commit is a commit that is never merged into `main`. Its parent is the selected `main` commit. A new `scripts/release/nightly.ts stamp <version>` writes only the version fields: `package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, the `pacer-desktop` entry in `desktop/src-tauri/Cargo.lock`, and the regenerated `src/app/assets.generated.ts` (`APP_VERSION`). It reuses the bump helpers from `scripts/release/prepare.ts`, which are exported for this purpose. Unlike `release:prepare`, it accepts only nightly versions and never touches `CHANGELOG.md`. `release.yml` therefore keeps its "tag equals `package.json` version" check unchanged. `main` never receives nightly version commits.

## Pipeline

A new workflow, `.github/workflows/nightly.yml`:

- **Triggers:** `schedule` at `0 17 * * *` (00:00 UTC+7, the maintainer's midnight), and `workflow_dispatch` with an optional `sha` input (default: `main` HEAD when the run starts).
- **Skip rule:** a scheduled run exits successfully without building when the selected `main` SHA equals the parent of the newest nightly tag. A manual run always builds.
- **CI gate:** the selected `main` SHA must have a green full CI suite on both OSes. A run waits for an in-progress CI run on that SHA, with a bounded timeout. Focused CI skips the full suite for some pushes, so when the SHA has no full-suite result, `nightly.yml` dispatches CI on `main`, guarded by a check that `main` still points at the SHA. If CI fails, or `main` moved, the night is skipped and reported.
- **Tag:** compute the version, create the stamp commit, push the annotated tag with the existing release token (the same mechanism `release-prepare.yml` uses), which triggers `release.yml`.
- **Concurrency:** one nightly at a time (`concurrency: nightly`, no cancellation of an in-progress run).

`release.yml` derives the channel from the version. A version matching `^\d+\.\d+\.\d+-nightly\.\d{12}$` is `nightly`. Any other version containing `-` stays a regular prerelease, and a version with no `-` is stable. For `nightly`:

- **Verify:** the verify job asserts that the diff between the stamp commit's parent and the tag touches only the five version files listed above. The `ci-suite` job then evaluates CI evidence for the parent (the `main` commit) and never dispatches a new CI run for a nightly; `nightly.yml` already waited for that evidence.
- **Build:** the full matrix from REL-3 (darwin and linux, arm64 and x64), native smoke tests, checksums and provenance attestations, all unchanged.
- **GitHub Release:** `--prerelease --latest=false`. Release notes are generated by `scripts/release/nightly.ts notes`: the commit titles between the previous nightly's parent and this one. They replace the CHANGELOG extraction for nightlies, and the desktop manifest (`desktop-release.ts prepare`) uses the same notes, truncated by `desktopNotes`.
- **npm:** publish with dist-tag `nightly` (not `next`; see the REL-5 amendment).
- **crates.io and Homebrew:** skipped (Homebrew is already skipped for every version containing `-`; the `crates` job gains the same check).
- **Desktop:** `desktop-build` and `desktop-publish` run for stable and nightly versions (other prereleases stay excluded). Build, sign and notarize as for stable (the signing identity and updater key are shared), validate both architectures, then compare-and-swap `nightly.json`. The real publisher accepts a GitHub prerelease only for the nightly channel.
- **CLI feed:** compare-and-swap `cli-nightly.json`.
- **Feed order:** both feeds advance only after every required artifact has been published and validated. A failure on any architecture leaves both feeds unchanged.
- **Failure reporting:** a failure in `nightly.yml`, or in any required `release.yml` job for a nightly tag, opens or updates a single issue labelled `nightly-failure`, linking the run. The next successful nightly closes it.

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

- A `DesktopChannel` (`"stable" | "nightly"`) selects the feed file and the version guard. `stableVersion()` keeps guarding `stable.json`. A new `nightlyVersion()` guards `nightly.json` and `cli-nightly.json`. Each feed rejects the other channel's versions. Both the GitHub and the local fixture publishers keep files other than the one they write (the fixture publisher currently writes a tree with only `stable.json`).
- No downgrades within a feed. A same-version, different-content publish is an immutable-version conflict, as today.
- Asset URLs in `nightly.json` point at the immutable `v<nightly>` release assets, using the existing asset names with the nightly version.

## Clients

### Channel setting

The channel is one installation-wide setting: the strategy key `update_channel`, `stable` (default) or `nightly`, managed like the existing `update_check` key (`src/core/config.ts` `CONFIG_KEYS`, mirrored in `crates/config/src/settings.rs`).

- **Desktop:** Settings → Updates shows a Stable/Nightly control that writes `update_channel` through `config.set`, the same way the automatic-check control writes `update_check`. Choosing Nightly shows a one-line warning that nightly builds are untested daily snapshots of `main`. After the write, the UI requests an explicit `desktop.update.check`. The service reads `update_channel` when it sends each native `check` command and passes it to the helper.
- **CLI:** `pacer config set update_channel nightly` subscribes. `pacer update`, `pacer update --check`, the service's `update.check` operation and `pacer status` all honor it. The TUI settings screens show it with the other config keys. When the desktop owns the installation, `pacer update` already defers to the app.
- **Cache:** `update-check.json` records the channel it was computed for. A cached result for a different channel is treated as stale.

`desktop.update.configure` is unchanged.

### Selecting an update

- **Stable:** read `stable.json` (desktop) or `latest.json` (CLI). Offer the update only if it is newer than the installed version. A nightly install that switches to stable therefore waits until stable passes it.
- **Nightly:** read both the stable and nightly feeds and pick the newest valid entry. If one feed is unreachable or invalid, use the other and report the failed feed in update status. The update is offered if it is newer than the installed version.

### Desktop trust

ADR 0001 requires that runtime input cannot select the feed. Both feed URLs are compile-time constants in `desktop/src-tauri/src/ota/trust.rs` (`STABLE_FEED`, a new `NIGHTLY_FEED`). The adapter's `check` command gains a `channel` field (`"stable" | "nightly"`), an enum that chooses among compiled constants, never a URL. Fixture builds read `feed/stable.json` or `feed/nightly.json` under their compiled fixture root.

The native updater currently accepts only `X.Y.Z` for both the feed and the installed version (`stable_version` in `updater.rs`), so an installed nightly could not construct its updater. It changes to accept `X.Y.Z` and `X.Y.Z-nightly.N` (and nothing else) for the installed version and for `nightly.json`; `stable.json` entries must still be `X.Y.Z`. The newer-only comparison uses semver precedence. The updater public key, signer pinning, bundle identity, artifact URL pinning (`releases/download/v<version>/…`), size limits and both-architecture validation are identical for both channels.

The download, wait-for-work, "Restart to update", recovery and helper transaction are unchanged.

### CLI parity

`pacer update` is implemented only in TypeScript (`src/update/`). The service's `update.check` operation runs natively in Rust (`crates/update`), and `test/native-service-update-parity.test.ts` compares the two byte for byte, including `update-check.json`. Both change together: reading `update_channel`, fetching `cli-nightly.json`, newest-of-both selection and the cache's channel field. The default nightly URL is `https://raw.githubusercontent.com/lamtuanvu/pacer/desktop-updates/cli-nightly.json`. With `PACER_RELEASE_BASE`, it is `<base>/cli-nightly.json`. `install.sh` gains `PACER_INSTALL_CHANNEL=nightly`, which reads the same feed.

### npm

`npm install -g @lamtuanvu/pacer@nightly` installs the newest nightly. A CLI installed from npm on the nightly channel reports updates and directs the user to that command (`installHint` in `src/update/update.ts`), the same way the stable channel uses `@latest` today.

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
| User switches nightly → stable | No change until a newer stable release exists. Settings explains this next to the control. |

## Testing

- **Unit:** version computation (next minor, timestamp formatting, no leading zero, ordering against stable), the channel classifier in `release.yml`'s verify script, `nightlyVersion()` and cross-channel rejection, newest-of-both selection, fallback when one feed fails, and no offer when on nightly with the stable channel selected.
- **Release fixtures:** extend `scripts/release/desktop-feed-fixture.ts` with a nightly promotion, an immutable retry and cross-channel rejection. `release.yml` keeps its tag-and-dispatch-only triggers; `nightly.yml` gains a `dry_run` dispatch input that computes the version, stamps and checks the diff without pushing a tag.
- **Rust and TS parity:** the `update_channel` key in `crates/config/tests/settings_parity.rs`, nightly cases in `test/native-service-update-parity.test.ts`, and the native updater's version rules in `updater.rs` tests.
- **Live validation (CT-11):** with the fixture bundle, a temporary `PACER_HOME` and fixture feeds, exercise switching to nightly, being offered a nightly over stable, moving from nightly to the next stable release, and switching back to stable without a downgrade, through the desktop Settings, `pacer desktop-update`, `pacer config set update_channel` and `pacer update --check`. Production signing and both-architecture publication are reported UNVERIFIED until the first real nightly runs.
- **First real run:** a manual `workflow_dispatch` nightly before enabling the schedule, with evidence attached to the PR.

## Delivery phases

Each phase is a separate PR.

1. **Governance:** ADR 0028, the REL-5 amendment, REL-9 and this spec.
2. **Pipeline:** `nightly.yml`, version computation, stamp commit and tag, the `release.yml` channel classifier, npm `nightly` dist-tag, GitHub prerelease and pruning. No feeds yet.
3. **Feeds:** `nightlyVersion()`, `nightly.json` and `cli-nightly.json` publishing, and fixture coverage.
4. **Channel setting and CLI client:** the `update_channel` key (TS and Rust), channel-aware `update.check` and `pacer update` (TS and Rust parity), `install.sh` and npm guidance.
5. **Desktop client:** `NIGHTLY_FEED`, nightly-aware native version rules, the `channel` field on the adapter `check` command, newest-of-both selection and the Settings control.
6. **Enable:** first manual nightly, then turn on the schedule.
