# Desktop-first onboarding

Tracking: lamtuanvu/pacer#188 (wave 3 of #130). It builds on [guided onboarding](2026-10-19-guided-onboarding-design.md) (wave 2) and resolves OD-5 and the open questions in [ADR clients-over-local-service](../decisions/2026-10-16-clients-over-local-service.md).

Status: decisions accepted by @lamtuanvu on 2026-10-19 (OD-5, recorded in `.project/decisions.md`).

## Problem

The intended front door is a download: get the app, open it, follow it. Today that path ends at the first screen:

- Releases publish only CLI binaries. The desktop app is built by the manual, unsigned `desktop.yml` workflow and is not published.
- The app needs a CLI installed separately. The shell already looks for `Contents/Resources/pacer` (`desktop/src-tauri/src/client.rs`), but nothing puts one in the bundle.
- Without a CLI on a fresh account, the app never reaches its install page. It retries `service install` every 20 seconds, then shows "pacer could not finish signing in… Waiting for the local service to start". The install page appears only when a service is already healthy (live test, 2026-10-19). Even that page has no action, and the "complete copy" it asks for doesn't exist.
- The shell manages the fixed launchd label `com.pacer.serve` whatever `PACER_HOME` and `PACER_PORT` say, and never checks that the job serves its own home. An app pointed at a second home starts the user's main service when it is stopped. If anything on the app's port accepts connections without answering health checks, the hung-service path restarts the main service with `kickstart -k`, without consulting the job at all.
- With a CLI it runs `service install` and `start` without asking. Wave 1 made service installation a consented step everywhere else.
- The app reports 0.1.0 while the package is 0.2.3 (REL-8).

## Goal

A macOS user downloads one signed app, opens it and reaches a reviewed first delegation. They need a terminal only when a provider's own login requires one.

Done means:

- The release has a signed, notarized app for each macOS architecture.
- A first launch on a clean account with no CLI gets the user to the web Setup screen in two clicks, both of them consent.
- Planner skills, hooks and the status line can call `pacer`, and they keep working after the app updates.
- Uninstall from the app removes everything setup added.

## Non-goals

- Windows (ADR consequence: the engine needs Windows support first).
- Mac App Store distribution (ADR D5).
- Replacing the CLI install. `install.sh` stays the headless and SSH path (ADR D6).
- A second setup UI. After the service starts, onboarding is the existing web Setup screen.

## Decisions (resolving OD-5)

| Question | Decision | Why |
|---|---|---|
| Bundled or attached CLI | **Bundled.** The app carries the same-version `pacer` binary. It attaches to an existing CLI only when the user chooses to keep it (below). | A download that needs a second install isn't a front door. The shell already has the candidate path. |
| Where the binary sits | `Contents/MacOS/pacer` as a Tauri `externalBin` sidecar, signed with the app. The `Contents/Resources/pacer` candidate stays for older builds. | Apple expects code in `Contents/MacOS`. Tauri signs sidecars during the bundle step. |
| How agents find `pacer` | With consent, the app creates a symlink `~/.local/bin/pacer` → the bundled binary, and the service, hooks and status line are installed with `PACER_BIN=~/.local/bin/pacer`. | Hooks record an absolute command (`src/install/self.ts`). A stable link survives app updates. A path inside the bundle breaks when the app moves. |
| Auth handoff | Keep the `pacer open --print` single-use code and cookie exchange. | Already implemented and reviewed (SEC-3). A token handed over at launch adds a second auth path. |
| Version | The app version equals the package version. `release:prepare` bumps `desktop/src-tauri/Cargo.toml` and `tauri.conf.json` (REL-8 becomes Established). | The sidecar and app ship together, so one number describes both. |
| Signing | **Unsigned first.** Phase 1 publishes unsigned app bundles labeled `-unsigned`, and the release notes document the Gatekeeper workaround (Control-click › Open). Developer ID signing and notarization in `release.yml` follow in phase 2, once the maintainer has a Developer ID. | It lets the bundled flow ship and get tested now. Gatekeeper friction on first open is accepted until phase 2. |
| Standalone tray helper | Not shipped. The tray lives in the app. | No demand yet; reconsider if headless users ask. |
| Notification ownership | Unchanged: the service selects one notifier through the `client.register` lease. | Already prevents duplicates. |

## First launch

The shell's bundled `ui/` owns every screen before the service is running. After that, the web app takes over.

```
open pacer.app
  └─ shell locates a CLI ───────────────┐
       none / bundled only              │ another pacer found on PATH
       ▼                                ▼
  1. Welcome                       1b. Existing install
     "Set up pacer"                    version, path, service state
       ▼                               [Use the app's pacer] [Keep mine]
  2. Consent (one screen)                   │                    │
     ☑ Run pacer in the background          ▼                    ▼
       at login (required)            relink + reinstall    attach as today
     ☑ Add `pacer` to your terminal   service with the      (app warns if the
       (~/.local/bin/pacer)           bundled binary         protocol differs)
     [Continue]                             │
       ▼                                    │
  3. Starting pacer… (existing page) ◀──────┘
       ▼
  4. Web app #/setup (wave 2): planner, connect, executor, Try it
```

- **Welcome** is one sentence about what pacer does and one button. It shows only when `PACER_HOME` has no `strategy.yaml` and no service is installed.
- **Consent** lists exactly what changes and how to undo it, as the Connect preview does. The service row can't be unticked: without it the app has nothing to show, and the copy says so. If `~/.local/bin` is not on the login-shell PATH, a third row appears: **"Add `~/.local/bin` to your PATH"**. It is an opt-in checkbox, unticked by default, that names the file it edits (the login shell's rc file: `~/.zshrc` for zsh, `~/.bashrc` for bash, otherwise it is not offered) and shows the exact line. When ticked, the app appends one block between `# >>> pacer >>>` and `# <<< pacer <<<` markers, written atomically, and never touches other lines. Uninstall removes only that block. When the row is left unticked, the screen shows the line with a Copy button instead.
- **Existing install**: a `pacer` that is not the app's link is reported with its version and path. "Use the app's pacer" reinstalls the service and the connected integrations with the bundled binary. The app never removes the other copy; for a Homebrew install it suggests `brew uninstall pacer` so the terminal and the service run the same version. "Keep mine" keeps today's attach behavior.
- The setup the shell performs is `pacer service install` through the bundled CLI with `PACER_BIN` set. Then it runs `pacer setup init --planner <detected>` only when exactly one planner is installed, otherwise the web Setup screen asks.
- The web Setup screen shows the service as done and starts at the planner step. The tray, which today reads the v2 setup shape, must read the same checklist (see the 2026-10-19 live test findings in #188).

## Updates

- Replacing `pacer.app` updates the sidecar. The shell already relaunches on bundle replacement. On launch it compares `pacer --version` against the service's `/v3/hello` version. If they differ and the service runs the linked binary, it restarts the service without asking again; the original consent covers updates.
- `pacer update` refuses when the real path of the running binary is inside an app bundle and says "Update the pacer app instead", mirroring the Homebrew refusal in `src/update/update.ts`.
- The app's own update channel (Sparkle or Tauri updater) is a follow-up. Until then, the app's existing protocol pages say "Download the new pacer app" and link to the release.

## Recovery pages

Each page gets one action, which the current ones lack.

| State | Message | Action |
|---|---|---|
| Bundle missing its CLI (checked before any service action, so the install branch can't fall through to the generic stuck page) | "This copy of pacer is incomplete." | Open the download page |
| Linked CLI deleted or moved | "pacer's terminal command was removed." | Recreate the link |
| Service binary differs from the app | "pacer is running an older version." | Restart with this version |
| Protocol mismatch, older service | as today | Use the app's pacer |
| Protocol mismatch, older app | as today | Open the download page |

## Uninstall

Settings → "Uninstall pacer" (wave 2) gains the app's own items: the `~/.local/bin/pacer` link, the PATH block in the shell rc file (if the app added it), the login item and the app itself. The shell runs the bundled `pacer uninstall --all --yes` after the confirmation, removes the link and login item, then shows "Move pacer to the Trash" with a button that does it (`NSWorkspace.recycle`). It never deletes another CLI it didn't create.

## Release

- `release.yml` gains a macOS desktop job that runs after the CLI build. It copies the CLI for each architecture to `desktop/src-tauri/binaries/pacer-<target-triple>`, builds with `--bundles app,dmg`, signs, notarizes and staples.
- Artifacts: `pacer-<version>-darwin-arm64.dmg` and `-darwin-x64.dmg`, in `SHA256SUMS` and covered by build attestation like the CLI.
- Phase 1 ships unsigned artifacts marked `-unsigned`, with the Gatekeeper workaround in the release notes. Phase 2 needs these secrets: an Apple Developer ID certificate and password, and a notarytool key. The job switches to signed and notarized builds when they exist.
- Linux: AppImage and deb carry the sidecar the same way and use the same link and consent. There is no notarization.
- README leads with "Download pacer for Mac" and keeps `install.sh` under "Terminal and servers".

## Security

- The sidecar runs with the user's permissions, as the CLI does today. No new privilege, helper tool or installer package.
- The link is created only after consent, with `O_EXCL` semantics: an existing file that isn't a link to this app is never overwritten without the "Use the app's pacer" choice.
- Desktop capabilities stay as SEC-8: the new consent screens are local `tauri://` pages that call Rust commands with no remote origin access.
- The shell passes argument vectors to the sidecar (SEC-5).
- The shell-profile edit happens only when its checkbox is ticked. It writes one marked block atomically (SEC-7 pattern: temp file, then rename, keeping the file's mode) and never rewrites or reorders other lines. If the file is a symlink or isn't writable, the app skips the edit and shows the line to copy.
- The shell touches launchd/systemd only for the service that serves its own `PACER_HOME`. It compares the job's `ProgramArguments` and port with its own before `kickstart` or restart, and otherwise shows "Another pacer is running" instead of acting. This also makes the live harness's desktop surface safe without relying on the PATH shim.

## Testing

- Unit (Rust): candidate order now includes `Contents/MacOS/pacer`, first-run detection, the consent gating of service install, link creation that refuses foreign files, and version-mismatch restart.
- Unit (TS): `pacer update` refusal inside a bundle; `PACER_BIN` flows into the service plist and hooks.
- Live (CT-11), on a fresh macOS account:
  1. No CLI: download → open → consent → Setup → Try it → accept. Hooks reference `~/.local/bin/pacer`.
  2. `install.sh` CLI present: both "Use the app's pacer" and "Keep mine".
  3. Replace the app with a newer build: the service restarts once on the new version and hooks still work.
  4. Uninstall from Settings: no link, login item, service, hooks or `PACER_HOME`; the app is in the Trash.
  5. Delete the sidecar from the bundle: the incomplete-copy page appears with its action.
  6. PATH opt-in: unticked leaves the rc file byte-identical; ticked adds exactly one marked block, and a second run doesn't duplicate it; uninstall removes the block and nothing else.

## Phases

1. **Bundle and consent (unsigned).** Sidecar, link, opt-in PATH edit, first-run screens, recovery actions, version sync, unsigned per-architecture release artifacts, README front door with the unsigned note.
2. **Signed release.** Developer ID signing and notarization, once the maintainer has a Developer ID.
3. **App updates.** In-app update channel.

## Resolved questions

Decided by @lamtuanvu on 2026-10-19:

- **Bundled vs attached CLI:** bundled, as proposed.
- **Universal binary or one per architecture:** one per architecture.
- **Editing the shell profile:** allowed, as an opt-in checkbox with a marked block that uninstall removes (see First launch).
- **"Keep mine":** remembered per CLI path and version.
- **Version:** the app version equals the package version; REL-8 is Established.
- **Signing:** unsigned first; Developer ID signing and notarization in phase 2.
