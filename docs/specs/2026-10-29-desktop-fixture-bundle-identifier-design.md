# Give fixture desktop builds their own bundle identifier

Date: 2026-10-29

Status: Proposed. This is part A of the [service upgrade with running work design](2026-10-29-service-upgrade-with-running-work-design.md).

## Problem

Fixture desktop builds for live validation use the release bundle identifier `dev.pacer.desktop`. The desktop uses Tauri's single-instance plugin (`desktop/src-tauri/src/main.rs:1242`). So while the user's installed app is running, launching a fixture build hands off to the real app instead of starting. Today every native live run therefore requires quitting `/Applications/pacer.app`.

## Outcome

Fixture builds use `dev.pacer.desktop.fixture`. The fixture app and the user's app run side by side. Release builds are unchanged.

## Design

- **Build.** The live build (`scripts/live/ota-build.ts`) sets the Tauri identifier to `dev.pacer.desktop.fixture` for `ota-fixture` builds. The derived identifiers get fixture variants too: `.native-shim`, `.update-helper` and `.cli`. Every check of the identifier reads one constant per language, and that constant is the fixture value only when the binary was compiled as a fixture. In TypeScript this is `compiledNativeFixture()`. It is never an environment variable or a config value, because a runtime override would weaken the release identity checks. The places that hard-code the identifier today:
  - **Rust desktop:**
    - `ota/trust.rs` `APP_ID` (the code-signing designated requirement)
    - `ota/wire.rs` `BUNDLE_ID`
    - `ota/platform.rs`
    - `ota/platform_adoption.rs`
    - `ota/helper_takeover.rs` (the Application Support path)
    - `packaging.rs`
    - `bin/pacer-update-helper.rs`
    - the identity metadata in `main.rs`
    - `ota/updater.rs`
    - `tauri.conf.json`
  - **Rust front door:** `crates/server/src/serve/native_trust.rs` and `native_bundle.rs`.
  - **TypeScript service:**
    - `src/update/desktop/identity.ts`
    - `adapter.ts`
    - `adoption-state.ts`
    - `native-os.ts`
    - `src/commands/open.ts`. Here `open -b` must target the fixture app from a fixture service, never the user's app.
  - **Live harness:** `scripts/live/ota-build.ts`, which today *requires* the release identifier, plus `ota-native.ts`, `ota-takeover.ts` and `ota-paired-proof.ts`.

  Release scripts (`scripts/release/*`) keep the literal, except `scripts/release/desktop-feed-fixture.ts`, which writes fixture feeds and uses the fixture identifier.
- **Release builds** never accept the fixture identifier. Tests on the production configuration assert this for the Rust desktop, the Rust front door and the TypeScript checks.
- **Config.** The fixture's application-support folder moves to `~/Library/Application Support/dev.pacer.desktop.fixture`, inside the fixture home. The user's real `consent.json` is never touched.
- **Harness.** The harness no longer refuses to launch while the real app is running.

## Validation

**Unit tests:**
- The identifier constant per build feature.
- A release build refuses fixture metadata.

**Live:** with the real app running, the five takeover scenarios and an upgrade scenario run in the fixture. The real app's process and its consent file stay unchanged.
