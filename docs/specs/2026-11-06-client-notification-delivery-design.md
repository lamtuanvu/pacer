# Client-owned notification delivery

Status: accepted 2026-11-06.
Source: maintainer request that OS/`osascript` notifications from the service
feel wrong when a client is open; delivery must come from the client that is
actually open (desktop app, TUI, or browser), with today’s plugin fallback
only when no delivery client is live.
Builds on:
[clients over one local service](../decisions/2026-10-16-clients-over-local-service.md)
(D1–D2), [UI functionality §10](2026-10-16-ui-functionality-design.md#10-notifications)
(historical lease + service fallback),
[UI implementation](2026-10-16-ui-implementation-design.md) (desktop posts
alerts; serve must not duplicate while desktop is connected),
[plugin extraction](2026-10-19-plugin-extraction-design.md) (`pacer-notify`),
and the current protocol narrative in [docs/protocol.md](../protocol.md).

Companion ADR:
[2026-11-06 client-owned notification delivery](../decisions/2026-11-06-client-notification-delivery.md)
records per-medium client delivery as the primary path; keep the existing
plugin OS fallback only when no delivery client is live. Keep “service decides;
clients deliver when present.”

## Intent

pacer’s local service already owns *what* deserves a notification (attention
flags, level `off|important|all`, delivery ledger). That stays. What is wrong
today is *who shows it when a client is open*: the host often ends up calling
the bundled `pacer-notify` plugin (`osascript` / `notify-send`) under the
service’s identity (a generic script / oasiscript-style notice) instead of the
desktop app, TUI, or browser that the user is actually using.

When a delivery client is live, that client presents in its native medium.
When **no** delivery client is live, keep today’s host fallback
(`pacer-notify` → `osascript` / `notify-send`, no actions) so headless /
background service use still notifies.

| Open client | Delivery medium |
| --- | --- |
| Desktop app (Tauri) | OS notification from the pacer desktop app (actions + deep link) |
| TUI (`pacer dashboard`) | Terminal notification (bell / terminal-native alert) |
| Browser app (`/app/` in a real browser) | Browser Notification API |
| None | Existing `pacer-notify` plugin (`osascript` / `notify-send`) |

## Goals

1. Service decides candidates and dedupes by key; live clients present.
2. Desktop, TUI, and standalone browser each register as delivery clients and
   present in their medium when live.
3. Host-initiated OS notification (`pacer-notify` / `osascript` /
   `notify-send`) runs **only** when the presenter set is empty — same
   behaviour as today’s no-notifier branch.
4. No duplicate presentation in the *same* medium when several clients of that
   medium are live.
5. Desktop webview continues to leave OS delivery to the Rust shell (existing
   stub of `platform.notify`).
6. Protocol stays backward compatible for wire shape where possible (P4);
   behaviour change is documented; clients ignore unknown fields.

## Non-goals

- Changing how attention items or notification *levels* are computed.
- Replacing in-app toasts (settings/job feedback) with OS/browser alerts.
- Restoring the retired Orca panel as a notifier (kind may remain in the
  registry for compatibility; no new Orca delivery work).
- Changing the no-client fallback’s presentation (still plugin OS notify
  without actions; no new branding work on that path).
- Redesigning notification copy, actions, or deep-link URL rules.
- Requiring a Rust port of `pacer-notify` for this change (existing TS plugin
  remains the empty-presenter fallback).

## Anti-goals

- Using the plugin/`osascript` path while any delivery client is live — that
  recreates the wrong-brand notice next to a real client.
- Browser Notification API firing inside the Tauri webview while the Rust
  shell also posts — doubles under the desktop brand.
- One global exclusive lease that silences the TUI whenever the desktop holds
  the lease (terminal and OS are different media; both may present).

## Constraints

- P1: `pacer serve` owns work; surfaces stay thin clients of the versioned API.
- P4 / API compatibility: additive event fields preferred; narrowing service
  self-delivery to the empty-presenter case is a behaviour clarification,
  not a field rename.
- P6: loopback + authenticated clients only.
- Existing desktop path (`client.register` with `notifier: true`, SSE
  `notify`, `client_id` filter, Tauri notification plugin) is the reference
  OS implementation and should keep working with minimal change.
- Never touch the maintainer’s real pacer install while validating (AGENTS.md).
- Live validation (`bun run live`) required before claiming done (CT-11).

## Current state (problem)

1. `src/notify/decide.ts` prefers `activeNotifier(ctx)` and publishes a
   `notify` entity with that `client_id`. Desktop already handles this.
2. Else it calls `deliverWithPlugins` → `plugins/pacer-notify` →
   `osascript` / `notify-send`. That is service delivery under another name.
3. TUI only edits `notifications.get` / `set`; it never registers, never
   handles `notify`, never rings the terminal.
4. Browser `platform.notify` exists but nothing drives it from service
   `notify` events; the app does not take a notifier lease.
5. Historical docs say “one notifier” globally. The wrong product shape is
   using the service/plugin path *while a client is open*; the empty-client
   fallback itself stays.

## Target model

### Decision authority (unchanged)

The pump still builds attention, reads the level, builds candidates
(`toNotify` + level-`all` transitions), and records successful deliveries in
`state/notified.json` (7-day retention). Keys stay
`` `${attentionId}:${since}` `` (and the existing mode/task keys).

### Delivery clients

A *delivery client* is a live `client.register` row with `notifier: true` and
a kind that maps to a medium:

| `kind` | Medium | Presenter |
| --- | --- | --- |
| `desktop` | `os` | Tauri notification plugin (existing) |
| `tui` | `terminal` | TUI terminal alert |
| `app` | `browser` | Browser Notification API |

Kinds `status`, `cli`, and `tray` do not become delivery clients in this
design (`tray` remains folded into the desktop app). Unknown future kinds
default to no medium until an ADR assigns one.

### Presenter selection (per medium)

For each candidate, the service selects **at most one live delivery client per
medium**, newest registration wins within that medium (same “newest live”
rule as today’s global `activeNotifier`, but scoped per medium).

**Cross-medium rule (builder must implement exactly this):**

- Always include the `terminal` presenter when a live `tui` delivery client
  exists.
- Include the `os` presenter when a live `desktop` delivery client exists.
- Include the `browser` presenter only when a live `app` delivery client
  exists **and** no live `os` presenter exists.

Rationale: Browser Notification API also surfaces as an OS-looking banner from
Chrome/Safari. Prefer the pacer desktop brand whenever the desktop app is
live; fall back to the browser when the user is on `/app/` without the
desktop shell. Terminal alerts do not compete with that banner and stay on.

If the selected presenter set is empty, use **today’s** no-notifier path:
`deliverWithPlugins` → enabled notifier plugins in id order (bundled
`pacer-notify` → `osascript` / `notify-send`, clipped title/body, no
actions). Mark the ledger when that path reports delivered, exactly as
`dispatchNotifications` already does. Do not publish a client `notify` event
on this branch.

### Wire event

Publish one outbox `notify` entity per candidate when the presenter set is
non-empty. Payload keeps today’s fields (`key`, `title`, `body`, `actions`,
`url`) and changes targeting as follows:

- **Additive:** `recipients: string[]` — the selected presenter `client_id`s.
- **Compatibility:** set `client_id` to the `os` presenter if present,
  otherwise the sole recipient, otherwise the first recipient. Today’s
  desktop filter on `client_id` keeps working; TUI/browser should prefer
  `recipients` (or treat membership in `recipients` as authority).

Clients deliver only when their `client_id` is in `recipients` (or equals
legacy `client_id` when `recipients` is absent — old services).

Ledger: mark the key delivered when the outbox publish succeeds for that
candidate (same success criterion as today’s client branch:
`transports.includes("outbox")`). Presentation failure on a client does not
re-open the key (same as today: once assigned, not retried through plugins).

### Surface behaviour

**Desktop (already mostly done)**

- Keep `client.register { kind: "desktop", notifier: true, … }` + heartbeat.
- Keep SSE → `from_event` → OS notification with actions/route.
- Prefer `recipients` when present; keep `client_id` equality as fallback.
- Webview `platform.notify` stays a no-op.

**TUI (new)**

- On dashboard start: `client.register { kind: "tui", version, notifier: true }`
  and heartbeat every 30 s; unregister/lapse on exit as other clients do.
- Subscribe to the same event stream the dashboard already uses (or add SSE /
  poll equivalent if the TUI is snapshot-only today — builder picks the
  existing TUI event path; do not invent a second protocol).
- On `notify` for this client: emit a terminal notification.
  - **Minimum:** audible bell (`\x07`) plus a one-line status/attention flash
    already consistent with the TUI vocabulary.
  - **Preferred when the terminal supports it:** OSC 9 or a documented
    terminal-native notification sequence, with silent fallback to bell +
    flash. Exact sequence is a builder call; must degrade cleanly over SSH.
- Level still comes from `notifications.get` / service decision; the TUI does
  not re-filter beyond “this event is for me.”

**Browser app (new)**

- When running as the standalone browser platform (`desktop: false`), register
  `client.register { kind: "app", version, notifier: true }` once the session
  is authenticated, and heartbeat while the page is open (pagehide / visibility
  may skip heartbeats; lease lapse is fine).
- On `notify` for this client: call `platform.notify(title, { body, … })`.
- If permission is not `granted`, do not fail the service path; surface a
  one-time Settings affordance to request permission when the user sets
  notifications to `important` or `all` (builder owns the exact UX copy).
- Inside the desktop webview: do **not** register as `app` notifier (shell
  already owns OS delivery).

### Host / plugin changes

- Keep the `else deliverWithPlugins(...)` branch, but only when the
  per-medium presenter set is empty (replace today’s single global
  `activeNotifier` check with the presenter-set check).
- Mirror the same policy in the Rust lifecycle twin.
- Keep bundled `pacer-notify` enabled as the empty-presenter fallback; do not
  delete it for this change.
- Update `docs/protocol.md` (via the protocol doc script) so the narrative is:
  live delivery clients present per medium; with none, the service posts via
  the notifier plugin as today.
- Snapshot `service.notifier` today names one global notifier. Change to
  either:
  - `service.notifiers: { os?, terminal?, browser? }` each
    `{ client_id, kind } | null`, **or**
  - keep `service.notifier` as the `os` presenter for old clients and add
    `service.notifiers` additively.

  Prefer the additive `service.notifiers` object (my call). When every medium
  is null, that is the empty-presenter / plugin-fallback case. Update
  read-model types and v2 compat projection accordingly.

### What success looks like

- With only the desktop app open: notifications appear as **pacer** (desktop),
  with actions; no `osascript`-branded notice.
- With only the TUI open: terminal bell/flash (and OSC if supported); no
  plugin/`osascript` OS banner from the service.
- With only a browser tab on `/app/`: browser notification after permission;
  no plugin/`osascript` from the service.
- With desktop + TUI: OS from desktop **and** terminal alert; no browser
  Notification; no plugin spawn.
- With desktop + browser tab: OS from desktop only (browser medium suppressed).
- With no delivery clients: same as today — `pacer-notify` posts
  `osascript` / `notify-send` without actions; ledger marks on success.

## Parts left to the builder

- Exact TUI event subscription plumbing and OSC sequence choice.
- Browser permission UX wording and where the request lives in Settings.
- Snapshot field naming in generated protocol docs (`service.notifiers`).
- Tests: unit coverage for per-medium selection, browser suppression, and
  empty-presenter → plugin fallback; client registry; desktop/TUI/browser
  registration hooks; live validation matrix above (CT-11), including the
  no-client fallback.
- ADR text that records per-medium presenters, browser-suppression-when-
  desktop-live, and plugin fallback only when no delivery client is live.

## Size and follow-on

This is a **written-design project**. After approval, implementation is planned
with `writing-plans` (service decide path, registry/snapshot, desktop tweak,
TUI delivery, browser delivery, docs, live evidence). No product code until
this document is approved.
