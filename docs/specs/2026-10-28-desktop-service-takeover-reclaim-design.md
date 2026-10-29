# Reclaim the desktop service after a takeover

Status: design approved by the maintainer in conversation on 2026-10-28, revised the same day to use a separate takeover transaction after the adoption engine was found to require a signed source service. [ADR 0011](../decisions/0011-desktop-service-takeover-reclaim.md) records the scoped exception to ADR 0001. Production enablement requires the live validation below.

## Problem

A user who chose **Use the app's pacer** at first launch gets a `~/.local/bin/pacer` symlink to the bundled CLI and a `com.pacer.serve` LaunchAgent whose program is `~/.local/bin/pacer serve`. The native identity check canonicalizes that path, finds the release-signed bundled CLI and grants update authority.

Copying another build onto `~/.local/bin/pacer` replaces the symlink with a regular file. Source builds do this when following the README (`cp dist/pacer dist/pacer-core "$HOME/.local/bin/"`), and so do local install scripts. launchd then runs that build. Its ad-hoc signature never matches the release signer, so every launch logs `native update authority unavailable for this service: Native update identity could not be verified`, and desktop OTA stops permanently.

Nothing in the app can repair this today:

- The first-run setup recreates only a missing link (`relink_needed`). A link replaced after consent is attached silently.
- Signed builds route service actions through `managed_service_action`, which requires the registration's `argv[0]` to be the bundle path and no other `pacer` process to be running.
- Service adoption is driven by the service itself. The helper accepts only a release-signed parent service, recovery authority is written by that service, and restoring the original requires its native channel. An unverifiable service can take part in none of this.
- The [legacy bootstrap design](2026-10-22-desktop-legacy-service-bootstrap-design.md) accepts only allowlisted official release digests, so a local or modified build stays `unknown-release`.

## Outcome

When the app's own consented setup was taken over, the desktop explains what happened and offers **Use the app's service**. After explicit confirmation, it moves the one registered service to the bundled signed CLI, verifies it and restores normal OTA. If verification fails, the original registration is restored. The other build is never run by the desktop, deleted or overwritten.

The repaired registration names the bundle path directly. Later copies into `~/.local/bin` change only the terminal command, not the service.

## Detection

Detection is read-only. It runs on every ordinary launch before the live-service version gate, because a takeover build commonly reports a different version and the version page would otherwise end the launch first. The desktop offers reclaim only when every condition holds:

1. The app's `consent.json` parses strictly with `keep: false`. A missing, malformed or `keep: true` record keeps today's behavior.
2. `observe_service_registration` succeeds: fixed label, allowed plist keys, `argv` of `<absolute path> serve`, `HOME`, `PACER_HOME` and port matching this desktop, user-owned regular plist that is not group- or world-writable, loaded job whose PID runs the registered program.
3. The registered program is a regular file, not a symlink, and is not the bundled CLI. A symlinked program is never offered, even one that points at another build; the desktop keeps today's behavior for it.
4. `inspect_registered_service` fails with an identity error.
5. `inspect_legacy_executable` captures the running program's file identity (device, inode, size, timestamps, SHA-256, cdhash bound to the PID).

Any other failure (foreign home or port, unexpected plist keys, ambiguous job, writable registration, unsigned or multiply-linked executable) keeps today's behavior. The service is never touched in that case.

Settings → Updates gains the reason `service-takeover` through the existing `desktop_update_connection` command. It adds no paths or capabilities. Older web apps that do not recognize the reason must not be offered it; the shell returns it only when the service's web app declares support, and otherwise keeps `service-identity`.

## Confirmation

The confirmation is a bundled shell page, not the service's web app, because that web app is served by the unverified build. The desktop shows it on launch when detection holds and the user has not dismissed it for this exact program identity. Settings → Updates links to it through a shell action.

The page shows:

- the current executable path and the version from its `/v3/hello`, labelled unverified;
- the replacement bundled executable, the registration label, port and data home;
- running and queued tasks (`task.list`) and live terminal sessions (`terminal.list`) read from the old service, labelled as best effort;
- a warning that pacer cannot confirm this build is idle and that running work may be interrupted;
- an optional checkbox, off by default: **Also point the terminal command at the app**;
- **Use the app's service** and **Not now**. **Not now** records a dismissal bound to the inspected program identity.

Confirming binds the inspected plist SHA-256, the loaded job's PID and process incarnation, and the program's file identity into a single-use authorization passed to the helper.

## Takeover transaction

The takeover is a separate transaction, not an adoption variant. It reuses the launchd, registration and private-file primitives and the independent recovery-job pattern. The adoption engine, its journal and its authority chain are unchanged.

The signed desktop starts the bundled `pacer-update-helper` in a new `--ota-takeover` mode over an inherited channel. The helper verifies that its parent is the release-signed desktop at the canonical app path, verifies the bundled CLI and itself, and accepts exactly one authorization.

Its journal lives under `$PACER_HOME/desktop-updates/native/takeover/<transaction id>/` with `transaction_kind: "takeover"`, so existing readers reject it. States: `prepared → stopping → switched → verifying → committed`, or `restoring → restored | recovery-failed` from any state after `prepared`. Each effect records its intent before execution and its observed completion afterward.

1. **Prepare.** Re-run detection and compare it to the authorization; any drift aborts with nothing changed. Snapshot the exact original plist bytes. A disabled override is refused, as in adoption. Copy the helper into the transaction directory and arm the recovery job (`--ota-recover-takeover <tx>`, `KeepAlive`, `RunAtLoad`).
2. **Stop.** `bootout` that exact job. Prove job absence and that the original PID exited.
3. **Switch.** Replace the registration with the managed definition: `argv` of `<bundled CLI> serve` and the environment `managed_service_action` writes (`HOME`, `PACER_HOME`, `PACER_PORT`, fixed `PATH`). Bootstrap it.
4. **Verify.** Within the 120-second awake-time limit, require `inspect_registered_service` to succeed for a fresh process incarnation, then a native connection, desktop sign-in and a valid state read. A heartbeat or HTTP PID claim is insufficient.
5. **Commit.** Record `committed` and retire the recovery job.

Before commit, any failure, desktop exit or helper crash leads the recovery job to restore. Restoration writes back the exact original plist bytes and bootstraps them. Its proof is that the loaded job's PID runs a program whose `inspect_legacy_executable` identity equals the one captured at confirmation, and that `/v3/hello` answers on the port. It does not require a native channel. If the program identity changed or the proof fails, the journal and snapshot are retained and the desktop reports recovery failure with retained evidence, as for other native transactions.

Waiting for work is best effort only: the old build cannot be assumed to honor the admission gate. Admission for the bundled service starts after commit.

## Terminal command

After commit, and only if the checkbox was selected, the desktop moves `~/.local/bin/pacer` to `~/.local/bin/pacer.pre-app-<UTC timestamp>` and creates the symlink to the bundled CLI. The move refuses if the file's identity differs from the one captured at confirmation, and never overwrites an existing entry. Failure here does not undo the committed service change; the desktop reports that the terminal command still runs the other build.

Without the checkbox, Settings shows that the terminal command and the service run different builds.

## Guidance

The README's source-install section warns that copying a build to `~/.local/bin/pacer` replaces the desktop's terminal command, and points to a sandboxed `PACER_HOME` and port for development builds.

## Out of scope

- Services the app never owned (no consent record, or `keep: true`). The legacy bootstrap design covers allowlisted official releases.
- Linux and Windows.
- Automatic reclaim without confirmation.

## Validation

Rust TDD covers:

- every detection predicate: consent missing, malformed or `keep: true`, symlink to the bundle, symlink elsewhere, regular file, foreign home or port, extra plist keys, writable plist, PID mismatch, multiply-linked executable;
- detection running before the version gate;
- authorization binding and drift of plist bytes, PID, incarnation and program identity;
- helper parent verification refusing an unsigned or non-desktop parent;
- the journal's transition graph, and existing adoption and update readers rejecting `transaction_kind: "takeover"`;
- each crash and restore boundary, including restore when the original program changed;
- the terminal relink refusing a changed file and never overwriting an existing backup.

The CT-11 live run needs a new fixture attach mode that registers an ad-hoc-signed binary at the fixture home's `.local/bin/pacer`, under a certificate-pinned lease so that binary fails verification. It exercises detection before the version gate, **Not now**, reclaim, data and settings preservation, OTA status becoming available, failed bundled start with restore, a helper crash during switch, and the optional relink. Native and VoiceOver surfaces that are not exercised are reported UNVERIFIED.

Desktop Rust tests run only in the manual Desktop workflow; the change must record a run of it. The maintainer's real service is changed only after the harness evidence passes, and only through the shipped app.
