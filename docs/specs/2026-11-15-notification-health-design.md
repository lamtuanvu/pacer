# Notification health and setup

Date: 2026-11-15. Status: approved by the maintainer (setup step optional; health proven by an end-to-end test acknowledgment).

## Problem

macOS banners from the pacer desktop app are pacer's main way to reach the user, but nothing checks them.

- The doctor has no notification check. Diagnostics and the setup gate never mention notifications.
- The desktop sends the service only `notifier: true|false`. The service can't tell "macOS never asked" from "denied", "quiet delivery only" or "banners off".
- "Delivered" means the outbox accepted the event. Nobody confirms that macOS accepted the banner.
- After a denial, the user can't fix anything from the app. There is no re-request, no System Settings link and no test.

## Goals

1. **Doctor check.** A `Notifications` check reports the real state and attaches one typed remedy that the app can carry out itself. The user's only manual step is the macOS toggle, and the app names it exactly (the desktop self-healing rule).
2. **Proof of delivery.** Health is proven end to end. A test notification travels service → desktop → `UNUserNotificationCenter`, and the desktop acknowledges the outcome back to the service.
3. **Setup.** Setup gets an optional step, "Turn on notifications", that never blocks finishing setup. Settings › Notifications shows the same live state and actions.

Non-goals:
- Notification actions or buttons on banners.
- Linux and Windows desktop shells.
- Changing presenter selection (the delivery decision D4).
- Fixing the Script Editor attribution of the osascript fallback.

## Design

### 1. The desktop reports permission state

`client.register` and `client.heartbeat` accept two optional fields:

- `notification_permission`: `"not_determined" | "denied" | "authorized" | "provisional" | "ephemeral" | "unsupported"`
- `notification_alerts`: `"none" | "banner" | "alert"` (from `UNNotificationSettings.alertStyle`)

The desktop reads both in `refresh_notifications()` before every heartbeat and sends them with `notifier`. A change wakes the heartbeat, as `notifier` already does. Unbundled dev builds send `"unsupported"`.

`ClientEntry` stores both fields, and an older value is kept while a heartbeat leaves them out. `permission_changed_at` records when either field changed, so a delivered test acked before the last change no longer reads as current. Until macOS has answered at least once (a real settings read or a request), the bundled desktop omits `notification_permission` rather than reporting `unsupported`; `unsupported` stays for unbundled and non-macOS builds. The Rust mirror (`crates/lifecycle/src/clients.rs`), the p6e goldens, the op catalog and the protocol docs are updated together. The frozen v2 surface does not change.

`permission_changed_at` moves only on a change between two real states: the previous stored value and the newly reported value must both be present and neither may be the `unsupported` placeholder. A first report (previously absent), a transition from `unsupported`, or an unchanged value therefore does not stamp the marker, so an app relaunch does not reset "test delivered". TypeScript (`src/clients/registry.ts`) and Rust (`crates/lifecycle/src/clients.rs`) apply this identical rule. The bundled desktop sets its "answered" flag only inside the macOS settings-read completion, after a real status was read, so a register at connect does not report the pre-read `unsupported` placeholder.

### 2. Delivery acknowledgment and test notifications

New ops:

| Op | Caller | Effect |
| --- | --- | --- |
| `notifications.test` | any client, CLI | Sends one `notify` event with key `test:<nonce>` to the OS presenter. Notification level and delivery ledger do not apply. Writes `{key, client_id, sent_at}` to `state/notification-health.json`, under the notifications lock and before the publish, so an ack that races the publish finds the new key. Fails with `unavailable` (hint: open the pacer app) when no desktop presenter is live. |
| `notifications.ack` | desktop client only | `{client_id, key, delivered: boolean, error?: string}`; `client_id` must be a live desktop lease, and the one the pending test targeted when the key matches. Records `last_ok_at` or `last_error {at, message}` for any key, and `acked_at`/`delivered` when it matches the pending test. `error` is optional (`null` accepted) and control characters are stripped and capped at 512 before storage. Unknown or stale keys are ignored. |
| `notifications.request` | any client | Sends a `control` event `{action: "notifications.request"}` targeted at the live desktop (`recipients`, unique id), which calls `requestAuthorizationWithOptions` and heartbeats the result. Waits up to `wait_s` seconds for the macOS answer; `wait_s` defaults to 20 and is capped at 25, keeping the call under the desktop's 30 s service-call timeout. |
| `notifications.health` | any client (v3-only, refused for executor sessions) | Cheap read that returns the `Check` object itself (its `tested_at` is set once the last test was acked after the last permission change) without running the full doctor; the Desktop banners row uses it. |

The desktop acks every `notify` event from the `addNotificationRequest` completion handler (`mac_notifications.rs`). A failed ack is logged and never retried.

`state/notification-health.json` is mode 0600, written atomically under the `notifications` lock, and bounded to a single record. Native routing stays as it is today: the Rust front door forwards these ops to TypeScript, and native `notifications.get/set` is unchanged.

Executor sessions (delegated pacer work) are refused for the new ops `notifications.test`, `notifications.ack`, `notifications.request`, `notifications.health` and `setup.skip`; `notifications.get` and `notifications.set` keep their prior policy (caller-policy).

#### The `control` v3 event

`notifications.request` publishes a `control` entity event, and `control` is a subscribable v3 API event that plugin policy observations may subscribe to (it was added to the v3 hello event set and the generated plugin policy protocol). Its payload is `{action, recipients, client_id}` and discloses only a desktop client id, which `notify` and `client.list` already expose. Because every future `control` action becomes plugin-observable automatically, `control` payloads must stay secret-free and safe for plugin observation (no endpoint keys, credentials or machine identity).

### 3. The doctor check

`runDoctor` adds one `Notifications` check. Rows are evaluated in order and the first match wins.

| State | Level | Detail | Remedy |
| --- | --- | --- | --- |
| level `off` | info | Notifications are off | — |
| no live desktop client | info | "pacer app isn't open; banners come from the system fallback" (evidence `unverified`) | — |
| permission `unsupported` | info | dev build can't post banners | — |
| `not_determined` | warn | macOS hasn't asked yet | auto: **Allow notifications** → `notifications.request` |
| `denied` | warn | macOS blocks pacer notifications | user: **Open Notification settings** → `x-apple.systempreferences:com.apple.Notifications-Settings.extension`, with the caption "Turn on Allow notifications for pacer" |
| `provisional` or alerts `none` | warn | Notifications arrive quietly, no banners | user: same link, with the caption "Choose Banners for pacer" |
| last test not acked within 15 s, or `last_error` newer than `last_ok_at` | warn | the desktop didn't confirm the test, or macOS rejected the banner (with its message) | auto: **Send test notification** → `notifications.test` |
| authorized, last test acked `delivered` after the last permission change | ok | "Banners allowed · test delivered" (evidence `tested`, with a structured `tested_at`) | — |
| authorized, never tested | ok | "Banners allowed · not tested yet" (evidence `configured`) | — |
| live desktop with no `notification_permission` (just registered) | info | "Checking notification permission…" | — |
| live desktop with no `notification_permission` (older app, registered ≥ 10 s ago) | info | "Update the pacer app to check notifications" | — |

`remedies` gains `allowNotifications()`, `notificationSettings(caption)` and `testNotification()`. `remedyCommand` maps them to `pacer api call …` or `open …`.

### 4. Opening System Settings from the desktop

Remedy URLs may already be `x-apple.systempreferences:` links, but the desktop throws on anything that isn't https (`app/src/data/remedies.ts`), and its navigation intercept only allows the Files and Folders pane (`main.rs`). Two changes fix this:

- Add an allowlisted Tauri command `open_system_settings(pane)`. The pane must be `notifications` or `privacy_files`, and each maps to a fixed URL, so the webview never sends a free-form URL.
- `openRemedyUrl` sends the two known System Settings URLs to that command on the desktop. Any other URL is still rejected.

### 5. Setup and Settings UI

- **Setup gate.** Add a step `notifications`, titled "Turn on notifications", after `usage_eligibility`. It reads the doctor check.
  - `passed` when the check is ok or info.
  - `needs_attention` (never `failed`) when it is warn, with the check's remedy as the gate repair, plus "Skip".
  - The outcome never becomes `hard_fail` because of this step. Skip is remembered per install in `settings.json` (`setup.notifications_skipped`), written under the config lock, and the step then reads "Skipped" (a neutral state, never the "Passed" label). A skipped step contributes no repair, so it never shows "Allow notifications" and never hides "Run checks again" or "Restart service". Diagnostics keeps showing the warning. The Notifications remedy (which prompts macOS interactively) stays out of Setup and Diagnostics fix-all; it remains an individual action. While it runs the UI shows "Answer the macOS prompt…".
- **Diagnostics.** The check renders as a normal `DiagnosticRow` (canvas boards 17 and 17c), so no new component is needed.
- **Settings › Notifications.** The canvas row "Desktop banners" (SettingsApp board) shows the live state in its caption ("Allowed · test delivered 2 min ago", "Blocked in System Settings", "Not asked yet"). Its control is the check's remedy button, or **Send test** when the check is ok. The on/off switch on the canvas would need a new presenter preference, which this work doesn't add. That deviation is recorded here, and the canvas board is updated in the same PR.

### 6. CLI

`pacer doctor` prints the new check. `pacer api call notifications.test` and `notifications.request` work without new subcommands.

## Testing

- **Unit:** the doctor state table, row by row, using fixture clients and health records; ack bookkeeping, including stale and unknown keys and the 15 s timeout; `notifications.test` without a presenter; setup-step mapping and skip; `remedyCommand`.
- **Parity:** the regenerated p6e goldens cover the new `ClientEntry` fields, and the Rust lifecycle tests pass.
- **Desktop:** `cargo test` for status and alert-style mapping and for the allowlist of `open_system_settings`.
- **Live (CT-11):** run `bun run live` with the signed fixture desktop (`dev.pacer.desktop.fixture`) and a sandbox `PACER_HOME`. Drive the doctor through not_determined → authorized → test delivered, and confirm in the usernoted DB (read-only) that the banner was recorded for the fixture bundle. If the denial path can't be driven safely, report it as UNVERIFIED.

## Risks

- `alertStyle` and provisional states vary between macOS versions. The doctor reports what macOS returns, and the unit tests cover every mapping.
- The test banner is a real banner, so the live harness sets the sandbox level to `important` and sends exactly one test.
