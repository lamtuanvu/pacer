# Desktop screens follow the live service version

Status: owner decision recorded 2026-10-26.

## Context

The desktop is a native client of the service UI, as decided in
[clients over one local service](2026-10-16-clients-over-local-service.md).
Installing a newer desktop app can leave an independently installed, still
running older service in place. In that case `/app/` serves older screens even
though the app bundle is new. A CLI file updated on disk does not change the
version of the running service.

## Decision

- The desktop reads the authenticated live service release before opening
  `/app/` and compares it to its own bundled release. An older service opens a
  native explanation with both versions, a bounded **Continue current work**
  action and update guidance. The older status remains in the native window
  title, tray and a native status notice in the old service page while those
  screens are open. A missing or malformed release
  shows an unverified-version state instead of claiming a match.
- A native shell acknowledgment applies to the observed service release for
  that app session. It does not grant update authority or mark the service as
  current. Reconnection checks the live release again.
- The desktop does not restart a live service simply because an executable on
  disk has a different version. Managed app and service updates continue to
  use the existing signed transaction, admission gate and rollback.
- An older standalone service without that admission capability needs one
  explicit service update after active work ends. Its legacy update action may
  restart immediately. Production service adoption remains gated by its
  separate validation.

## Consequences

The desktop never silently labels old service screens as the new release. A
legacy installation still requires a one-time manual step before new controls
work. This decision preserves the single service-owned UI and adds no second
transport or update path.
