# Test Orca onboarding

Use a fresh disposable OS account or VM with Orca >=1.4.224. Run these manual
checks only there; automated tests use temporary homes and fake process calls.
Install agent CLIs separately if testing agent connections.

## Marketplace bootstrap

1. In Orca Settings > Plugins, add `https://github.com/lamtuanvu/pacer.git`
   as a marketplace and install pacer (`lamtuanvu.pacer`). Enable it and grant
   its capabilities. For the versioned bundle, use ref `orca-plugin-v0.1.17`.
2. Open the panel. It shows **Set up pacer** and numbered one-time setup
   instructions. This static page has no buttons or live checklist.
3. Without clicking, check for **Installing pacer…**, then **pacer is ready. Last step:**
   with the absolute development-folder path and Orca settings instructions.
   The worker prepares that folder once per plugin version; no terminal,
   pacer console or agent config should appear yet.
4. Check `pacer --version`, `pacer service status --json`, and `pacer status`.
   The binary, strategy and service should be installed. Before the release
   is published, set the plugin's **releaseBase** to a staged HTTPS, file://
   or localhost release folder containing `0.1.17/SHA256SUMS` and the binary.
   A missing release produces one friendly notification and bounded retries.
5. Reopen the panel and restart Orca. The marketplace folder must be unchanged,
   the static panel must still open without “failed integrity verification”,
   and previously delivered milestones must not repeat.

## Finish setup and live panel

1. Check that the worker prepared `~/.pacer/orca-plugin` without typing into
   any terminal. Restarting the worker must not repeat the copy or notification.
2. Read the absolute folder path in the ready notification. In Orca Settings >
   Plugins, uninstall the marketplace pacer; under **Development**, add that
   folder (normally `~/.pacer/orca-plugin`), then enable pacer.
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
file changes. Only development-folder panels reload, which is why this one-time
handoff is required: [Orca #26951](https://github.com/stablyai/orca/issues/26951).
pacer never edits Orca settings to add a development folder.

## Recovery and cleanup

In the disposable account, stop the pacer service and verify the worker restarts
it with bounded retries. After the development handoff, close a pacer console
and confirm autoConsole reopens it in the focused worktree. Bootstrap mode must
never open a console.

Undo connected agents with `pacer uninstall <agent>`, run `pacer service
uninstall` and `pacer plugin uninstall`, then remove the development folder
entry from Orca Settings > Plugins. Remove the disposable account or VM.

## Report

Record Orca and pacer versions, install source, notification timings, unchanged
marketplace folder after restart, automatic folder preparation, absence of terminal actions,
marketplace/development status, agent consent, self-heal and any error output.
