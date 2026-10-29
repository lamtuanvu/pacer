# Give fixture desktop builds their own bundle identifier

Date: 2026-10-29

Status: Proposed. This is part A of the [service upgrade with running work design](2026-10-29-service-upgrade-with-running-work-design.md).

## Problem

Fixture desktop builds for live validation use the release bundle identifier `dev.pacer.desktop`. The desktop uses Tauri's single-instance plugin (`desktop/src-tauri/src/main.rs:1242`). So while the user's installed app is running, launching a fixture build hands off to the real app instead of starting. Today every native live run therefore requires quitting `/Applications/pacer.app`.

## Outcome

Fixture builds use `dev.pacer.desktop.fixture`. The fixture app and the user's app run side by side. Release builds are unchanged.

## Design

- **Build.** The live build (`scripts/live/ota-build.ts`) overrides the Tauri identifier for `ota-fixture` builds. Code that checks `"dev.pacer.desktop"` reads the expected identifier from one constant. That constant is the fixture identifier only when the `ota-fixture` feature is compiled in. The places that check it:
  - `desktop/src-tauri/src/packaging.rs`
  - `desktop/src-tauri/src/bin/pacer-update-helper.rs`
  - the identity metadata in `main.rs`
  - the update feed checks in `ota/updater.rs`
- **Release builds** never accept the fixture identifier. A test builds the production configuration and asserts this.
- **Config.** The fixture's application-support folder moves to `~/Library/Application Support/dev.pacer.desktop.fixture`, inside the fixture home. The user's real `consent.json` is never touched.
- **Harness.** The harness no longer refuses to launch while the real app is running.

## Validation

**Unit tests:**
- The identifier constant per build feature.
- A release build refuses fixture metadata.

**Live:** with the real app running, the five takeover scenarios and an upgrade scenario run in the fixture. The real app's process and its consent file stay unchanged.
