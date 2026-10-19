# Test Orca onboarding

For routine runtime changes, use [live validation](live-validation.md) with isolated state and CT-11 evidence. This page covers fresh-account onboarding.

Use a fresh disposable OS account or VM with Orca >=1.4.224. Run these manual
checks only there; automated tests use temporary homes and fake process calls.
Install agent CLIs separately if testing agent connections.

## Marketplace bootstrap

1. In Orca Settings > Plugins, add `https://github.com/lamtuanvu/pacer.git`
   as a marketplace and install pacer (`lamtuanvu.pacer`). Enable it and grant
   its capabilities. For the versioned bundle, use ref `orca-plugin-v0.2.3`.
2. Open the static panel. It shows **Set up pacer**, an installation spinner
   and elapsed timer, dashboard instructions, and collapsed **Prefer the sidebar
   panel?** steps. After two minutes it shows the terminal version check hint.
3. Without clicking, check for **Installing pacer…**, then **pacer is running
   in the pacer terminal tab.** One **pacer** terminal should open in the active
   worktree with the live dashboard. No agent configs should change.
4. Check `pacer --version`, `pacer service status --json`, and `pacer status`.
   For staged releases, set **releaseBase** to a folder containing
   `0.2.3/SHA256SUMS` and the binary. Missing releases get friendly failures.
5. Restart only the plugin worker: no duplicate terminal should appear. Close
   the dashboard and restart the worker again: it must stay closed. Run
   `pacer dashboard` to reopen it yourself. A new Orca session may open one tab.
6. Exercise j/k or arrows, Enter retry/focus/stop, d delegate (repo defaults to
   cwd, optional kind), x dismiss, b block/unblock, s strategy, r refresh, ? help
   and q quit. Resize below 60 columns and shorten the terminal: selection
   remains visible. Check NO_COLOR and PACER_NO_ANIM, Ctrl-C and SIGTERM; the
   cursor, normal screen and cooked input must be restored.
7. Reopen the panel and restart Orca. The marketplace folder stays unchanged
   and opens without “failed integrity verification”. Milestone notifications
   must not repeat. Check the optional managed folder was prepared.

## Optional sidebar panel

1. Check that the worker prepared `~/.pacer/orca-plugin` without typing into
   any terminal. Restarting the worker must not repeat the copy or notification.
2. In Orca Settings > Plugins, uninstall the marketplace pacer; under
   **Development**, add `~/.pacer/orca-plugin`, then enable pacer.
3. Run `pacer plugin status`: marketplace should be absent and development
   installed. The managed folder has a JSON `.pacer-managed` marker with
   `version` and `installedAt`; the published bundle must not contain it.
4. The development panel now shows the live budget and the original checklist:
   **Install pacer**, **Start pacer**, **Connect your agents**. Reopening it
   shows current data. The worker refreshes it as data changes.
5. Check the detected agent list and file preview, then click **Connect my
   agents**. Only this click authorizes `pacer setup --yes` and agent config
   changes. Confirm the connected labels and the printed undo commands.

Orca verifies marketplace content hashes and does not reload those panels on
file changes. Only development-folder panels reload, which is why the sidebar uses an optional
development folder: [Orca #26951](https://github.com/stablyai/orca/issues/26951).
pacer never edits Orca settings to add a development folder.

## Recovery and cleanup

In the disposable account, stop the pacer service and verify the worker restarts
it with bounded retries. After the development handoff, close the pacer dashboard
and confirm autoConsole reopens it in the focused worktree. Bootstrap mode opens only the dashboard, once per Orca session.

Undo connected agents with `pacer uninstall <agent>`, run `pacer service
uninstall` and `pacer plugin uninstall`, then remove the development folder
entry from Orca Settings > Plugins. Remove the disposable account or VM.

## Report

Record Orca and pacer versions, install source, notification timings, unchanged
marketplace folder after restart, automatic folder preparation, dashboard launch deduplication,
marketplace/development status, agent consent, self-heal and any error output.
