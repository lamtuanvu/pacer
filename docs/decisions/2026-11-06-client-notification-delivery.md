# Client-owned notification delivery — 2026-11-06

Status: owner decision recorded 2026-11-06.
Source: [client-owned notification delivery design](../specs/2026-11-06-client-notification-delivery-design.md).
Builds on [clients over one local service](2026-10-16-clients-over-local-service.md) (D1–D2) and the existing
`pacer-notify` plugin fallback.

## Context

The local service already decides *what* deserves a notification (attention
items, level `off|important|all`, delivery ledger). When a user has a live
client open, OS alerts from the service identity (`osascript` / `notify-send`
via the bundled notifier plugin) feel wrong: the open desktop app, TUI, or
browser should present in its native medium instead.

Historically the protocol described one global notifier and service self-post
when none was registered. That matched a single exclusive lease but not
per-medium delivery (terminal vs OS vs browser).

## Decisions

- **D1. Service decides; live clients deliver.** The notification pump,
  candidate keys, and ledger stay in the service. When delivery clients are
  live, presentation happens in the client; the service publishes targeted
  `notify` events rather than calling the plugin path.
- **D2. Per-medium presenters.** A delivery client is a live `client.register`
  row with `notifier: true` and a kind that maps to a medium: `desktop` →
  `os`, `tui` → `terminal`, `app` → `browser`. For each candidate the
  service selects at most one live delivery client per medium (newest
  registration wins within that medium).
- **D3. Browser suppressed when desktop is live.** Include the `browser`
  presenter only when a live `app` delivery client exists **and** no live
  `os` presenter exists. Rationale: browser notifications look like OS
  banners; prefer the desktop brand when the desktop app is open. The
  `terminal` presenter is independent and may coexist with `os`.
- **D4. Plugin fallback only when the presenter set is empty.** When no
  delivery client is live, use the existing no-notifier path:
  `deliverWithPlugins` → enabled notifier plugins in id order (bundled
  `pacer-notify` → `osascript` / `notify-send`, no actions). Do not run that
  path while any presenter is selected.
- **D5. Additive wire and snapshot fields.** `notify` events add
  `recipients: string[]` (selected presenter `client_id`s). Keep `client_id`
  for compatibility (the `os` presenter when present, otherwise a sole or
  first recipient). Clients deliver when listed in `recipients`, or when
  `recipients` is absent and `client_id` matches (old services). The snapshot
  adds `service.notifiers: { os?, terminal?, browser? }` naming each live
  presenter; `service.notifier` remains the `os` presenter for older clients.

## Alternatives considered

- **Keep one global notifier lease.** Rejected: TUI and desktop are different
  media; a global lease silences terminal alerts when the desktop holds the
  lease, or forces plugin OS notify while the desktop is open.
- **Always use the plugin for OS delivery.** Rejected: duplicates the wrong
  brand next to a live desktop or browser client.

## Consequences

- Protocol narrative and generated docs describe per-medium delivery and the
  empty-presenter plugin fallback ([`scripts/protocol-doc.ts`](../../scripts/protocol-doc.ts)).
- Desktop webview continues to leave OS delivery to the Rust shell; standalone
  browser sessions register as `app` notifiers.
- Presentation failure on a client does not re-open the ledger key (same as
  today’s client branch once assigned).

## Revisit when

- A new client kind needs a delivery medium (assign via ADR).
- Product requires actionable OS notifications on the headless fallback path.
