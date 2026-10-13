# Orca link spike: human checklist

Target: Orca 1.4.224, pluginApi 1. This is a throwaway development-path plugin.
Only a human enables the plugin and grants consent in Orca's UI. Preparation
does not establish a live result: all results start as `PENDING` in
[the decision record](../../docs/decisions/2026-10-12-orca-link-transport.md).
Record the Orca version, time, actual output, and any discrepancy there after
each step. Keep unrelated commands and events quiet during the lifecycle test.

- [ ] **S1 (HTTP).** Run `pacer serve` using the default home and port 4317
  (the worker reads `~/.pacer/token`; Orca does not pass `PACER_HOME`). Open
  Settings -> Plugins in Orca, turn the plugin system on, and add the absolute
  development path `<repo>/orca-plugin/spike`. Review and enable the plugin.
  Run the palette command **pacer spike: probe http**. Expected: a notification
  `HTTP 200 {...planner...}`. Record errors or token-read failures verbatim.
- [ ] **S2 (storage bridge).** From the repo, run
  `bun orca-plugin/spike/write-storage.ts`, then **pacer spike: probe storage**.
  Expected: the notification shows the new `probe` value. Repeat once without
  restarting Orca and compare against the script's printed probe value, to
  demonstrate that storage is re-read every time. This writes only the spike's
  `plugins-data/pacer.pacer-spike/storage.json` link key and preserves other keys.
- [ ] **S3 (panel re-read).** Open the **pacer spike** panel and note its stamp
  (initially `STAMP`). Its button should show a notification through the panel
  bridge. Run `bun orca-plugin/spike/stamp-panel.ts`, then close and reopen the
  panel. Expected: a new stamp, no integrity error in plugin logs, and no
  re-consent prompt. Record all three observations. Use a development path,
  since an installed copy has integrity checks.
- [ ] **S4 (terminal send).** Focus a worktree that has a terminal and run
  **pacer spike: probe terminal send**. Expected: `: pacer-spike 'hello'`
  appears in the first terminal without Enter. Also try a handle from another
  worktree: obtain it from `orca terminal list --json`, temporarily change the
  worker's `id` selection to that handle, and invoke the command after the
  edited worker is loaded (disable/re-enable if needed). Record whether Orca
  accepts it and which terminal receives the text; restore the original code.
  Compare `tabId` and `leafId` in `orca terminal list --json` with
  `echo $ORCA_PANE_KEY` inside that terminal. Record whether
  `paneKey == tabId + ":" + leafId`. Use an idle shell for the probe.
- [ ] **S5 (lifecycle).** Observe logs from enablement onward: does
  `spike activated` appear on enablement (eager start), or only on the first
  command or event (lazy start)? Leave Orca idle for 6 minutes, then look for
  **worker reaped after idle period**. Record whether the minute-by-minute
  `alive` lines keep it alive. Expected: they do not count as activity; command
  results and delivered events do. Record intervening activity if any.
- [ ] **S6 (commands).** Run **pacer spike: probe http** from the palette.
  Record how the returned `{ args, r }` value is shown, if at all. A returned
  `args: null` represents the worker's `args ?? null`; to distinguish
  `undefined` from `null`, temporarily log `args === undefined` in the handler,
  reload the worker, invoke from the palette, and restore the code. Record
  whether palette invocation supplies `undefined`.
- [ ] **Cleanup.** Remove the development path in Orca, disabling and dropping
  the plugin. Do not remove unrelated plugin data or edit Orca settings on disk.

If a result contradicts the code-derived expectations, preserve the observed
result and use the decision record's **If live results contradict** section.
