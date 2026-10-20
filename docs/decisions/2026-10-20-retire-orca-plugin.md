# Retire the Orca plugin — 2026-10-20

Status: proposed with governance amendment 0.5.0; adopted when the maintainer merges its PR.
Source: the maintainer's request to remove the Orca plugin and run pacer as a dedicated app, following the
[desktop-first onboarding design](../specs/2026-10-19-desktop-first-onboarding-design.md) (#188, #203).
This record supersedes the [information-only decision](2026-10-15-orca-plugin-information-only.md), the
[panel commands decision](2026-10-14-orca-panel-commands.md) and the plugin parts of the
[link transport decision](2026-10-12-orca-link-transport.md). It does not change the Orca execution backend.

## Context

- The desktop app is now the onboarding front door. It bundles a same-version CLI and opens the pacer app
  (web UI and tray), where users delegate, review and change settings.
- The Orca plugin panel duplicated a read-only subset of that app. Since the
  [information-only decision](2026-10-15-orca-plugin-information-only.md) it could not act, and it pointed users to
  `pacer dashboard` or the app anyway.
- Installing it needed manual steps in Orca's settings (a development plugin folder), because Orca refreshes only
  development-folder panels.
- Orca exposes no plugin reload API or CLI, so every pacer update left a stale plugin and a "Needs you" reload item.
- The plugin's bundled pacer copy could replace the user's `pacer` command with an older version. This happened during
  the desktop-first rollout, when 0.1.24 overwrote the app's CLI link.
- Keeping it cost a release channel (the `orca-plugin` branch and `orca-plugin-v<ver>` tags), a marketplace manifest,
  committed generated output, a real-Orca e2e before each plugin release, and UI rules for a third surface.

## Decision

- **D1. Remove the Orca plugin:** delete the worker, the panel, the marketplace manifest (`orca-marketplace.json`),
  the bundled plugin assets and `plugin:build`. The service stops writing the panel and stops refreshing the plugin
  after updates. `release.yml` stops publishing the `orca-plugin` branch and tags; existing tags stay where they are.
- **D2. Keep the Orca execution backend:** delegated runs may still execute in Orca worktrees and terminals
  (`src/exec/orca`), and Orca accounts are still read. Orca remains a supported host, not a client surface (P3, ARCH-5).
- **D3. Clean up leftover installs:** `pacer uninstall --all` and `pacer plugin uninstall` remove a previously
  installed plugin folder and its install record. pacer never edits Orca's settings, so users remove the development
  plugin path or the marketplace entry in Orca themselves.
- **D4. The thin clients are the CLI, the TUI, the web app and tray, and the desktop shell.**

## Consequences

- P7, ARCH-6, UI-5, REL-4, REL-7 and CT-10 are retired (constitution 0.5.0). P8 and ARCH-4 keep only "`src/core`
  never imports `src/exec/orca`". P11 and CT-5 no longer cover plugin `dist/`.
- Users who relied on the Orca panel open the pacer app or the tray instead.
- The plugin ADRs above and `docs/testing/orca-e2e.md` become historical. The code-removal PR updates or removes the
  docs that still describe the plugin as current.

## Revisit when

Orca gains a plugin API that lets a panel act through the pacer API and reload itself, and users ask for an
in-Orca surface again.
