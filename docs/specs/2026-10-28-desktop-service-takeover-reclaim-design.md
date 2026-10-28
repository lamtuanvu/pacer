# Reclaim the desktop service after a takeover

Status: design approved by the maintainer in conversation on 2026-10-28. [ADR 0011](../decisions/0011-desktop-service-takeover-reclaim.md) records the scoped exception to ADR 0001. Production enablement requires the live validation below.

## Problem

A user who chose **Use the app's pacer** at first launch gets a `~/.local/bin/pacer` symlink to the bundled CLI and a `com.pacer.serve` LaunchAgent whose program is `~/.local/bin/pacer serve`. The native identity check canonicalizes that path, finds the release-signed bundled CLI and grants update authority.

Copying another build onto `~/.local/bin/pacer` replaces the symlink with a regular file. Source builds do this when following the README (`cp dist/pacer dist/pacer-core "$HOME/.local/bin/"`), and so do local install scripts. launchd then runs that build. Its ad-hoc signature never matches the release signer, so every launch logs `native update authority unavailable for this service: Native update identity could not be verified`, and desktop OTA stops permanently.

Nothing in the app can repair this today:

- The first-run setup recreates only a missing link (`relink_needed`). A link replaced after consent is attached silently.
- Signed builds route service actions through `managed_service_action`, which requires the registration's `argv[0]` to be the bundle path and no other `pacer` process to be running.
- Service adoption starts only from a verified native session. The [legacy bootstrap design](2026-10-22-desktop-legacy-service-bootstrap-design.md) accepts only allowlisted official release digests, so a local or modified build stays `unknown-release`.

## Outcome

When the app's own consented setup was taken over, Settings → Updates explains what happened and offers **Use the app's service**. After explicit confirmation, the desktop moves the one registered service to the bundled signed CLI, verifies it and restores normal OTA. If verification fails, the original registration is restored. The other build is never run, deleted or overwritten.

The repaired registration names the bundle path directly. Later copies into `~/.local/bin` change only the terminal command, not the service.

## Detection

Detection is read-only and runs on every ordinary launch after native verification fails. The desktop offers reclaim only when every condition holds:

1. The app's `consent.json` exists with `keep: false`. A missing record or `keep: true` keeps today's "unavailable" status.
2. `com.pacer.serve` is loaded for the current user and its plist passes the existing registration checks: fixed label, allowed keys, `argv` of `<absolute path> serve`, `HOME`, `PACER_HOME` and port matching this desktop, user-owned file, not group- or world-writable, not a symlink.
3. The program path canonicalizes to something other than the bundled CLI, and native identity verification of the running process fails.
4. The loaded job's PID matches the process whose executable is the registered program.

Any other mismatch (foreign home or port, unexpected plist keys, ambiguous job, writable registration) stays unavailable with its specific reason. The service is never touched in that case.

Public status adds a reason `service-takeover` beside the existing `service-identity`. The status does not include paths or capabilities.

## Confirmation

The confirmation page shows:

- the current executable path and its version as reported by the running service's `/v3/hello`, labelled unverified;
- the replacement bundled executable, the registration label, port and data home;
- active tasks and live terminal sessions read from the old service's API, labelled as best effort;
- a warning that pacer cannot confirm this build is idle and that running work may be interrupted;
- an optional checkbox, off by default: **Also point the terminal command at the app**.

Confirming binds the inspected plist SHA-256, the job's PID and process incarnation, and the bundled CLI's code identity into a single-use authorization. Any drift between inspection and execution aborts before effects begin.

## Transaction

Reclaim is a new source-provenance variant, `takeover`, in the existing native adoption journal. Existing records without the discriminator keep the signed-source policy. Unknown variants fail closed. The variant's authority is the consent record plus the confirmation; it never grants the source build ordinary native-session or OTA authority.

1. Reverify the signed app, bundled CLI and update helper, the consent record, and the confirmed plist bytes, PID and incarnation.
2. Snapshot the exact original registration and any disabled override. Persist the authorization and arm the independent recovery job before any effect.
3. `bootout` that exact job. Prove job absence and process exit.
4. Write a registration whose `argv[0]` is the bundle path, with the environment `managed_service_action` uses. Bootstrap it.
5. Verify native identity, a fresh process incarnation, desktop sign-in and a valid state read. A heartbeat or HTTP PID claim is insufficient.
6. Commit durably and retire the recovery job.

Before commit, any failure, desktop crash or helper crash leads the recovery job to restore the original registration bytes and verify that the same original executable is running again (same path and file identity as inspected). Restoring the original does not require it to support OTA. If restoration cannot be verified, the journal and snapshot are retained and Settings reports recovery failure, as for other adoption transactions.

Waiting for work is best effort only: the old build cannot be assumed to honor the admission gate. Admission for the bundled service starts after commit.

## Terminal command

After commit, and only if the checkbox was selected, the desktop moves `~/.local/bin/pacer` to `~/.local/bin/pacer.pre-app-<UTC timestamp>` and creates the symlink with `link::create`. The move refuses if the file changed since confirmation. Failure here does not undo the committed service change; Settings reports that the terminal command still runs the other build.

Without the checkbox, Settings shows that the terminal command and the service run different builds.

## Guidance

The README's source-install section warns that copying a build to `~/.local/bin/pacer` replaces the desktop's terminal command, and points to a sandboxed `PACER_HOME` and port for development builds.

## Out of scope

- Services the app never owned (no consent record, or `keep: true`). The legacy bootstrap design covers allowlisted official releases.
- Linux and Windows.
- Automatic reclaim without confirmation.

## Validation

Rust TDD covers:

- every detection predicate: consent missing, `keep: true`, symlink to the bundle, symlink elsewhere, regular file, foreign home or port, extra plist keys, writable plist, PID mismatch;
- confirmation binding and drift of plist bytes, PID, incarnation and bundled CLI;
- journal variant parity between TS and Rust and fail-closed handling of unknown variants;
- each crash and restore boundary, including restore when the original executable changed;
- the terminal relink refusing a changed file and never overwriting an existing backup.

The CT-11 live run uses a harness fixture whose consented setup has an ad-hoc-signed service binary at the link path. It exercises detection, cancel, reclaim, data and settings preservation, OTA status becoming available, failed bundled start with restore, and the optional relink. Native and VoiceOver surfaces that are not exercised are reported UNVERIFIED. The maintainer's real service is changed only after the harness evidence passes, and only through the shipped app.
