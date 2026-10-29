# Desktop updates

Desktop OTA updates install one complete macOS release: the app, bundled service,
CLI and embedded UI. The first OTA-capable release must be installed manually.
Production publishing remains disabled until the signed native validation matrix
is accepted; an unsigned development build does not enable production OTA.

The disposable Apple Silicon harness has verified a complete upgrade and recovery
from failed candidate startup, helper crash, and interruption after installation.
Recovery checks include fresh desktop/service sign-in, data preservation, and
continued app/service operation after the recovery job retires. Deliberate
restoration failure also preserved recovery evidence and kept admission closed.
This is development evidence using disposable signatures. Developer
ID signing, notarization, Intel execution and reboot recovery still require release
validation. The native adapter does not yet advertise service adoption; its API
and interface remain capability-gated until native adoption validation passes.

## Connection failures

If the desktop cannot verify its connection to the service, Settings → Updates
reports **Automatic desktop updates are unavailable**, with the reason when the
native shell can provide it. Normal service work may continue. A missing desktop
update status does not mean that a desktop update was checked or installed.
Manual installation is a separate, labelled fallback option.

CLI-installed services can lack the release identity and native channel required
by desktop updates. An explicit legacy-service bootstrap is being designed to
transfer a supported service safely; the connection diagnostic alone does not
perform that transfer or grant update authority.

### Desktop is newer than the running service

The desktop window loads its screens from the running service. If that service is
older, the desktop shows both live versions before opening those screens. Choose
**Continue current work** to use the older screens for now; new controls such as
Dispatcher appear only after the service itself runs the newer release. The
desktop checks the live service response, not just a CLI file on disk.

For a separately installed older service, finish running tasks and terminal
sessions before using that installation's update method. Its legacy updater may
restart the service immediately. The old **Settings → Updates** button does not
wait for active work. Update the CLI with its original installer (`pacer update`,
`brew upgrade pacer`, or `npm install -g @lamtuanvu/pacer@latest` as appropriate),
then run `pacer service restart` after work has finished. Quit and reopen the
desktop; confirm the running service version shown there matches the desktop
version. A CLI version shown by `pacer --version` alone does not prove that the
already-running service has restarted.

Once service adoption is validated and available, a compatible service can use
the managed update transaction described below. The desktop never starts a
legacy service update automatically.

### Service replaced by another build

If a previously consented desktop service runs from a build the app cannot
verify, the desktop offers **Use the app's service** before its normal version
check. The confirmation is a page bundled with the app, not the service's web
app. It shows both command paths, the version the other build reports, the
service label, port, data home and any work counts it can read. **Not now**
keeps the current service and is remembered for that executable identity. A
changed executable causes the choice to appear again. While the offer is open,
the desktop checks the service about every 30 seconds instead of continuously.

**Settings → Updates** explains that the service was replaced and offers
**Review service replacement**, which opens the same confirmation page, also
after **Not now**. Settings also notes when the terminal command and the
service run different builds.

Confirming stops the inspected service job, registers the signed CLI bundled
with the app and verifies the new service. Settings and task data stay in the
same home; the original command file stays in place. The optional terminal
checkbox moves that file to a timestamped `pacer.pre-app-*` backup and links
`~/.local/bin/pacer` to the bundled CLI. If that step fails after the service
was replaced, a notification says so; move `~/.local/bin/pacer` aside and reopen
pacer, which offers to recreate the command. If the service changed after you
reviewed it, nothing is changed. **Use the app's service** ignores clicks for a
second after the page appears or the window regains focus.

If startup fails, the original registration and service are restored. A
separate recovery job finishes the restore even if the helper or the desktop
stops during the switch. If the helper stopped before that job was set up, the
desktop runs the recovery once itself. Until the transaction finishes, the desktop shows that
the service is being replaced and does not install, start or sign in to the
service. It then shows **Kept your current service** with the reason. **Continue
current service** also hides the offer for that build, like **Not now**. If
recovery cannot verify the original service, the desktop shows **Service
replacement needs attention** on every launch. It shows the same page when a
transaction record can't be read, or when its one recovery run left it
unfinished. Keep the transaction files under
`$PACER_HOME/desktop-updates/native/takeover/` and follow the recovery guidance
below. Older committed or restored transactions are removed once a newer one
exists; recovery-failed ones are kept.

## Updating

Open **Settings → Updates** while the desktop is connected. Pacer checks daily
and downloads eligible updates automatically by default. Turn off automatic
downloads to choose when to download; **Check for updates** remains available.
After the complete package is verified, choose **Restart to update**.

Pacer waits for running work and live terminal sessions. It does not close a
session to make an update proceed. The waiting screen identifies blockers and
offers **Cancel update**. Cancelling retains the download and requires a new
restart request. Quitting the requesting desktop or restarting the machine also
expires a waiting request. Once installation starts, cancellation is unavailable.

During installation, the managed service holds new work. The replacement desktop
and service must authenticate, read state successfully and complete desktop
sign-in before work resumes. Startup verification has a 120-second limit measured
while the computer is awake. The native helper continues recovery independently
of the app and service.

The CLI exposes the same service operations. Use the registered installation ID
and current revision from status; a restart additionally pins the offered version:

```sh
pacer desktop-update status --installation INSTALLATION_ID --json
pacer desktop-update check --installation INSTALLATION_ID
pacer desktop-update download --installation INSTALLATION_ID
pacer desktop-update restart --installation INSTALLATION_ID --version VERSION --revision REVISION
pacer desktop-update cancel --installation INSTALLATION_ID
pacer desktop-update configure --installation INSTALLATION_ID --auto-download off
```

A stale revision returns a conflict so another client's decision cannot be
overwritten. Keep `--request-id` unchanged when retrying an uncertain request;
reuse with different parameters is rejected. A running service and verified
desktop connection are required for actions. These commands are separate from
`pacer update`, which updates standalone CLI installations.

## Ownership and compatibility

Pacer verifies the canonical app, signed executable identities, process
incarnations, service registration, data home and port. A matching process name
or listening port does not establish ownership. The destination must be writable
without administrator access. Permission failures never trigger elevation.

An attached external service keeps its own update method. A compatible desktop
update replaces only the app and reconnects to that same service. It does not
stop the external service or change its registration, CLI, hooks or data. Taking
ownership requires the separate explicit service-adoption flow; an unsupported
service cannot be adopted by force.

When **Use the desktop service** is available, its confirmation shows the current
and replacement service executables, registration label and port. The change
waits for active work, then switches the registration to the bundled CLI and
verifies the desktop's connection. It preserves the external CLI files and data.
**Cancel service change** is available while waiting. If startup fails, recovery
restores and verifies the original service registration. A completed transfer
shows the previous and resulting installation IDs.

For CLI adoption, first read status and confirm the two displayed paths:

```sh
pacer desktop-update adopt --installation INSTALLATION_ID --from-service CURRENT_EXECUTABLE --to-service DESKTOP_EXECUTABLE
pacer desktop-update adopt-cancel --installation INSTALLATION_ID
```

These paths confirm the inspected change; they cannot select another executable.
An explicit `--revision` for `adopt` uses the update revision; `adopt-cancel` uses
the separate service-change revision shown in status.

The initial supported baseline must implement admission and recovery. Known old
or conflicting pacer processes block maintenance when their work cannot be
accounted for. Process enumeration cannot reliably identify an arbitrarily
renamed legacy executable; do not run independent older binaries against the
same data home during maintenance.

The bundled CLI refuses standalone self-replacement, including direct execution
from inside the app. Update the whole desktop package instead. Linux and Windows
OTA, remote host updates and automatic changes to npm/Homebrew installations are
outside this macOS feature.

## Recovery

If startup verification fails after installation begins, pacer restores the
previous complete package and managed registration, then verifies them before
reopening work admission. Settings, task history and credential references stay
in place; recovery does not replace the data directory with an old snapshot.
The failed candidate is excluded from automatic retry. Cancelling before
installation does not quarantine the candidate.

A successful release is not automatically rolled back after it begins accepting
work. If restoration cannot be verified, pacer reports recovery failure and
retains the journal and backup. Keep those files and the data home, quit the
desktop, and report the diagnostic information through the repository's issue
tracker. Do not delete the recovery directory or manually reopen the work gate.

Private recovery records live under `$PACER_HOME/desktop-updates/`. They include
process and installation authority and are not public API payloads. Avoid posting
these files wholesale; redact private paths and identifiers in a diagnostic
report. Update signatures and Apple code identity are checked before candidate
code executes. Production builds use a compiled trust key and signing team. Their native
transport library is signed with the same team and verified before loading;
runtime environment variables cannot redirect desktop update trust.
Release validation starts the signed helper's native runtime and updater plugin
before notarization, in addition to testing the CLI's native socket transport.

See [distribution](distribution.md#signed-macos-desktop-updates) for release
requirements, [live validation](testing/live-validation.md) for disposable
fixtures, and [the architecture decision](decisions/0001-desktop-ota.md) for
maintenance and recovery boundaries.
