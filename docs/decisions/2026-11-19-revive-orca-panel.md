# Revive the Orca panel — 2026-11-19

Status: proposed with governance amendment 0.24.0; adopted when the maintainer merges its PR.
Source: the maintainer's request to reduce context-switching between Orca and pacer, following the
[Orca panel design](../specs/2026-11-19-orca-panel-plugin-design.md).
This record answers the "Revisit when" clause of [ADR retire-orca-plugin](2026-10-20-retire-orca-plugin.md):
Orca now has a plugin API that lets a panel act through the pacer API and reload itself, and users ask for an
in-Orca surface again. It narrows that ADR's D3; its other decisions (the Orca execution backend, the thin-client
model) stand.

## Context

- The 2026-10-20 ADR removed the Orca plugin because Orca's plugin API could not support it: no panel-to-worker
  call (buttons injected `: pacer '<json>'` text into a console), no reload API (updates left a stale panel), and
  manual development-folder installs only. That ADR's own "Revisit when" clause named the condition under which
  to reconsider.
- Orca's plugin system has since grown exactly that: a `worker-panel` template with a typed panel↔worker
  protocol, persistent `orca.storage`, and real install/update/reload tooling (`plugin install`, `plugin update`,
  `plugin dev reload`, `plugin restart`). This is substantially the `plugin.invokeCommand` action pacer had
  drafted and never posted upstream (commit `00517e62e`, path `docs/upstream/orca-panel-worker-call.md`, deleted
  when the plugin was removed).
- The reason to revive now: reduce context-switching. The user wants to stay in Orca and act on what pacer needs
  from them (reviews, stuck tasks, budget) without alt-tabbing to the pacer app or tray for the common cases.
- The 2026-10-20 ADR's Context also records the 0.1.24 incident: the plugin's bundled pacer copy could replace
  the user's `pacer` command with an older version, and during the desktop-first rollout 0.1.24 overwrote the
  app's CLI link. Any revival must state the boundary that prevents that explicitly, not leave it implicit.

## Decision

- **D1. An Orca panel plugin is built again,** scoped to one `status` bar item and one sidebar `panelTab`. The
  worker is an ordinary pacer v3 HTTP/SSE client — the same bearer-token auth every other client (CLI, TUI, web
  app and tray) already uses — and the panel renders as a pacer-owned `"ui":"html"` page (pacer's own design
  tokens, not Orca's generic component styling or theme variables), because `orca plugin check`'s mount() kit
  only supports `"ui":"components"` panels and this panel needed its own branded look. It acts through the pacer
  API and reloads itself: the two things the retired plugin could not do. Its scope is what you need while
  working in an Orca worktree: pace, what needs you, delegating from that worktree, what is running, who runs
  next and what finished today. Settings and everything else stay in the pacer app.
- **D2. `pacer plugin install`/`update`/`status`/`uninstall` are revived** (verbs retired in amendment 0.5.0).
  This narrows D3 of the 2026-10-20 ADR to: pacer may invoke the `orca` CLI to manage this plugin's own
  install/update/uninstall only; it still never edits Orca's settings directly and never writes to or replaces
  the user's own `pacer` CLI binary, symlink or PATH entry. That boundary is explicit because of the 0.1.24
  incident: the retired plugin's bundled pacer copy overwrote the user's `pacer` command with an older version.
- The rest of the rationale — transport and token handling, the Orca sandbox and capability grants, the
  action model driven by the service's own `attention[].actions`, rejected approaches and non-goals — is in the
  [Orca panel design](../specs/2026-11-19-orca-panel-plugin-design.md).

## Consequences

- P7 and ARCH-6 stay retired in the constitution until amendment 0.24.0 is adopted; the amendment is what makes
  the plugin legal under the repository's own rules, so it lands before or alongside the first panel code. The
  status cells change only when the maintainer merges the amendment PR.
- The Orca panel becomes a pacer client again, the same tier as the web app, while the Orca execution backend
  (D2 of the 2026-10-20 ADR) is unchanged. pacer manages only this plugin's install/update/uninstall through the
  `orca` CLI; other plugins, Orca's settings and the user's `pacer` binary, symlink and PATH entry are untouched.
- A third UI surface returns, with the costs the 2026-10-20 ADR recorded: release packaging, real-Orca
  validation before releases, and UI rules for the panel. The design doc's non-goals keep the panel out of the
  settings, strategy-management and app-replacement territory that motivated the removal.

## Revisit when

- Orca's plugin API regresses — the panel can no longer act through the pacer API or reload/update itself — or
  the panel goes stale after updates again.
- The plugin's upkeep costs (release channel, e2e, third-surface UI rules) exceed the context-switching it
  saves, the trade that motivated the 2026-10-20 removal.
