# M3 Test Triage

Snapshot of the Bun test tree for the M3 (Rust) migration. Every `test/**` code file
(`*.ts`, `*.tsx`) is classified into exactly one bucket; data files map to the code
files that reference them. Regenerate with `bun run test:triage`.

## Buckets

| Bucket | Meaning | Fate |
|---|---|---|
| `binary-e2e` | drives `pacer` as a process over the CLI, stdio or HTTP | kept; repointed to the Rust binary in D3 |
| `src-unit` | imports `src/` to unit-test TypeScript behavior | deleted in the B or C slice that ports the behavior |
| `kept` | tests `app/`, `packages/`, `conformance/` or `scripts/` without importing `src/` | kept |
| `parity` | compares TypeScript with Rust (front-door differential, parity harness, Rust goldens) | deleted in D3; its goldens stay as Rust tests |
| `plugin` | tests a bundled TS plugin under `plugins/<id>/` | moves with C13 (to `examples/plugins/<id>/` tests or deleted with the TS plugin) |

## Summary

| Bucket | Files | Lines |
|---|---:|---:|
| binary-e2e | 16 | 3562 |
| src-unit | 897 | 125485 |
| kept | 359 | 33179 |
| parity | 154 | 28615 |
| plugin | 48 | 9193 |

**Total: 1474 code files (1263 tests + 211 support).**

## Code files

| Path | Kind | Bucket | Signal | Lines | src | transitive-src | Area |
|---|---|---|---|---:|---:|---|---|
| test/account-list-single-read.test.ts | test | src-unit | src | 35 | 3 | yes | account |
| test/account-signin-state.test.ts | test | src-unit | src | 237 | 16 | yes | account |
| test/account-signin.test.ts | test | src-unit | src | 132 | 7 | yes | account |
| test/account-usage-check.test.ts | test | src-unit | src | 80 | 5 | yes | account |
| test/account-usage-probe.test.ts | test | src-unit | src | 101 | 7 | yes | account |
| test/accounts-edit-endpoint-plugin.test.ts | test | src-unit | src | 35 | 4 | yes | accounts |
| test/accounts-golden.test.ts | test | plugin | plugin | 160 | 6 | yes | accounts |
| test/accounts-parity.test.ts | test | parity | parity | 50 | 2 | yes | accounts |
| test/activity-log.test.ts | test | src-unit | src | 295 | 13 | yes | activity |
| test/activity.test.ts | test | src-unit | src | 164 | 2 | yes | activity.test.ts |
| test/agent-detect.test.ts | test | src-unit | src | 104 | 5 | yes | agent |
| test/agent-session-adapters.test.ts | test | plugin | plugin | 106 | 0 | no | agent |
| test/answer.test.ts | test | src-unit | src | 170 | 6 | yes | answer.test.ts |
| test/api-client-http.test.ts | test | src-unit | src | 176 | 5 | yes | api |
| test/api-client.test.ts | test | src-unit | src | 71 | 5 | yes | api |
| test/api-cmd.test.ts | test | src-unit | src | 114 | 6 | yes | api |
| test/api-desktop-reconciliation.test.ts | test | src-unit | src | 59 | 7 | yes | api |
| test/api-desktop-update.test.ts | test | src-unit | src | 584 | 14 | yes | api |
| test/api-discovery.test.ts | test | src-unit | src | 42 | 2 | yes | api |
| test/api-error-contract.test.ts | test | src-unit | src | 28 | 3 | yes | api |
| test/api-events.test.ts | test | src-unit | src | 138 | 20 | yes | api |
| test/api-http.test.ts | test | src-unit | src | 362 | 13 | yes | api |
| test/api-log-follow.test.ts | test | src-unit | src | 64 | 2 | yes | api |
| test/api-machine.test.ts | test | src-unit | src | 120 | 5 | yes | api |
| test/api-ops-accounts.test.ts | test | src-unit | src | 134 | 8 | yes | api |
| test/api-ops-config.test.ts | test | src-unit | src | 323 | 10 | yes | api |
| test/api-ops-endpoint.test.ts | test | src-unit | src | 163 | 8 | yes | api |
| test/api-ops-executor-models.test.ts | test | src-unit | src | 35 | 1 | yes | api |
| test/api-ops-opencode-setup.test.ts | test | src-unit | src | 64 | 2 | yes | api |
| test/api-ops-pause.test.ts | test | src-unit | src | 46 | 6 | yes | api |
| test/api-ops-strategy.test.ts | test | src-unit | src | 145 | 4 | yes | api |
| test/api-ops-upgrade.test.ts | test | src-unit | src | 90 | 7 | yes | api |
| test/api-ops-usage-refresh.test.ts | test | src-unit | src | 19 | 1 | yes | api |
| test/api-ops.test.ts | test | src-unit | src | 181 | 11 | yes | api |
| test/api-project-strategies.test.ts | test | src-unit | src | 105 | 9 | yes | api |
| test/api-protocol-doc.test.ts | test | src-unit | src | 51 | 3 | yes | api |
| test/api-read-model-capacity.test.ts | test | src-unit | src | 131 | 6 | yes | api |
| test/api-read-model-summary.test.ts | test | src-unit | src | 214 | 17 | yes | api |
| test/api-read-model-tasks.test.ts | test | src-unit | src | 72 | 3 | yes | api |
| test/api-sqlite-snapshot.test.ts | test | src-unit | src | 53 | 2 | yes | api |
| test/api-stdio-client.test.ts | test | src-unit | src | 144 | 4 | yes | api |
| test/api-stdio.test.ts | test | src-unit | src | 121 | 3 | yes | api |
| test/api-task-list-enrichment.test.ts | test | src-unit | src | 57 | 6 | yes | api |
| test/api-terminal.test.ts | test | src-unit | src | 104 | 6 | yes | api |
| test/api-v2-compat.test.ts | test | src-unit | src | 470 | 21 | yes | api |
| test/api-v3.test.ts | test | src-unit | src | 105 | 12 | yes | api |
| test/api.test.ts | test | src-unit | src | 264 | 6 | yes | api.test.ts |
| test/app-account-usage-browser.test.tsx | test | kept | none | 245 | 0 | yes | app |
| test/app-actions.test.ts | test | src-unit | src | 138 | 1 | yes | app |
| test/app-agent-mark.test.tsx | test | src-unit | src | 99 | 2 | yes | app |
| test/app-answer-attention.test.ts | test | src-unit | src | 69 | 11 | yes | app |
| test/app-assistant-browser.test.tsx | test | kept | none | 631 | 0 | no | app |
| test/app-assistant-entry.test.ts | test | kept | none | 18 | 0 | no | app |
| test/app-assistant-model.test.ts | test | src-unit | src | 52 | 1 | yes | app |
| test/app-attempt-panel.test.tsx | test | kept | none | 56 | 0 | yes | app |
| test/app-auth.test.ts | test | src-unit | src | 371 | 12 | yes | app |
| test/app-beautiful-ui.test.tsx | test | kept | none | 50 | 0 | yes | app |
| test/app-board-controls.test.tsx | test | src-unit | src | 68 | 1 | yes | app |
| test/app-bundle.test.ts | test | src-unit | src | 42 | 1 | yes | app |
| test/app-choice-picker-browser.test.tsx | test | kept | none | 190 | 0 | no | app |
| test/app-choice-picker.test.tsx | test | kept | none | 72 | 0 | yes | app |
| test/app-client-control.test.ts | test | kept | none | 17 | 0 | yes | app |
| test/app-command-menu-browser.test.tsx | test | kept | none | 614 | 0 | no | app |
| test/app-command-registry.test.ts | test | kept | none | 89 | 0 | no | app |
| test/app-command-search.test.ts | test | kept | none | 264 | 0 | yes | app |
| test/app-compact-density.test.tsx | test | kept | none | 86 | 0 | yes | app |
| test/app-context-menu.test.ts | test | kept | none | 64 | 0 | no | app |
| test/app-conversation-action.test.ts | test | src-unit | src | 15 | 2 | yes | app |
| test/app-conversation-browser.test.ts | test | kept | none | 149 | 0 | no | app |
| test/app-conversation-shell.test.tsx | test | src-unit | src | 81 | 1 | yes | app |
| test/app-delegate.test.tsx | test | kept | none | 107 | 0 | yes | app |
| test/app-desktop-connection-layout.test.tsx | test | kept | none | 35 | 0 | no | app |
| test/app-desktop-ipc-transport.test.ts | test | src-unit | src | 277 | 1 | yes | app |
| test/app-desktop-menu-bridge.test.ts | test | kept | none | 180 | 0 | yes | app |
| test/app-desktop-reconciliation.test.tsx | test | kept | none | 50 | 0 | yes | app |
| test/app-desktop-transport.test.ts | test | src-unit | src | 73 | 1 | yes | app |
| test/app-desktop-update-connection.test.tsx | test | src-unit | src | 74 | 1 | yes | app |
| test/app-desktop-updates.test.tsx | test | src-unit | src | 198 | 2 | yes | app |
| test/app-desktop-version-row.test.tsx | test | kept | none | 20 | 0 | yes | app |
| test/app-desktop-version.test.ts | test | src-unit | src | 51 | 1 | yes | app |
| test/app-diagnostics-browser.test.tsx | test | kept | none | 513 | 0 | yes | app |
| test/app-diagnostics-restart-browser.test.tsx | test | kept | none | 133 | 0 | yes | app |
| test/app-diagnostics.test.tsx | test | plugin | plugin | 740 | 30 | yes | app |
| test/app-dialogs.test.tsx | test | kept | none | 74 | 0 | yes | app |
| test/app-discovery.test.tsx | test | kept | none | 349 | 0 | yes | app |
| test/app-dispatch-age-browser.test.ts | test | kept | none | 22 | 0 | no | app |
| test/app-dispatch-fidelity-live.test.ts | test | kept | none | 38 | 0 | no | app |
| test/app-dispatch-links.test.ts | test | kept | none | 12 | 0 | yes | app |
| test/app-dispatch-panels-live.test.ts | test | kept | none | 79 | 0 | no | app |
| test/app-dispatch-trace.test.tsx | test | src-unit | src | 91 | 2 | yes | app |
| test/app-dispatch.test.tsx | test | src-unit | src | 580 | 3 | yes | app |
| test/app-dispatcher-model-choice.test.tsx | test | src-unit | src | 344 | 2 | yes | app |
| test/app-dispatcher-settings.test.tsx | test | src-unit | src | 413 | 2 | yes | app |
| test/app-dispatcher-setup.test.tsx | test | src-unit | src | 276 | 1 | yes | app |
| test/app-dropdown-migration.test.ts | test | kept | none | 22 | 0 | no | app |
| test/app-ds-browser.test.tsx | test | kept | none | 81 | 0 | yes | app |
| test/app-ds-components.test.tsx | test | src-unit | src | 99 | 1 | yes | app |
| test/app-ds-controls.test.tsx | test | kept | none | 56 | 0 | yes | app |
| test/app-ds-redesign-browser.test.tsx | test | kept | none | 60 | 0 | yes | app |
| test/app-ds-redesign-primitives.test.tsx | test | kept | none | 141 | 0 | yes | app |
| test/app-ds-share-bar.test.tsx | test | src-unit | src | 54 | 1 | yes | app |
| test/app-executor-browser.test.ts | test | kept | none | 278 | 0 | no | app |
| test/app-executor-draft.test.ts | test | kept | none | 25 | 0 | no | app |
| test/app-executor-models-model.test.ts | test | src-unit | src | 79 | 2 | yes | app |
| test/app-executor-models.test.tsx | test | src-unit | src | 413 | 2 | yes | app |
| test/app-failure-review-browser.test.tsx | test | kept | none | 87 | 0 | no | app |
| test/app-failure-review.test.tsx | test | src-unit | src | 95 | 1 | yes | app |
| test/app-fidelity-frame-live.test.ts | test | kept | none | 91 | 0 | no | app |
| test/app-file-viewer-browser.test.tsx | test | kept | none | 401 | 0 | no | app |
| test/app-filter-refresh-browser.test.tsx | test | kept | none | 102 | 0 | no | app |
| test/app-final-alignment.test.tsx | test | kept | none | 81 | 0 | yes | app |
| test/app-frame-browser.test.tsx | test | kept | none | 816 | 0 | no | app |
| test/app-frame-terminal-live.test.ts | test | kept | none | 151 | 0 | no | app |
| test/app-frame.test.tsx | test | src-unit | src | 133 | 1 | yes | app |
| test/app-immediate-save-browser.test.tsx | test | kept | none | 107 | 0 | yes | app |
| test/app-insights-browser.test.tsx | test | kept | none | 150 | 0 | no | app |
| test/app-insights-budget.test.ts | test | src-unit | src | 16 | 1 | yes | app |
| test/app-keys.test.ts | test | kept | none | 167 | 0 | no | app |
| test/app-log-follow.test.ts | test | kept | none | 48 | 0 | yes | app |
| test/app-machine-launch-browser.test.tsx | test | kept | none | 138 | 0 | yes | app |
| test/app-machine-parallel-tasks-browser.test.tsx | test | kept | none | 269 | 0 | yes | app |
| test/app-managed-action-errors-browser.test.ts | test | kept | none | 159 | 0 | no | app |
| test/app-managed-root.test.tsx | test | src-unit | src | 76 | 2 | yes | app |
| test/app-managed-task-page.test.tsx | test | src-unit | src | 34 | 1 | yes | app |
| test/app-model-accounts.test.ts | test | src-unit | src | 38 | 2 | yes | app |
| test/app-model-diff.test.ts | test | kept | none | 20 | 0 | no | app |
| test/app-model-executors.test.ts | test | kept | none | 23 | 0 | yes | app |
| test/app-model-matrix-screen.test.tsx | test | src-unit | src | 861 | 3 | yes | app |
| test/app-model-matrix.test.ts | test | src-unit | src | 249 | 1 | yes | app |
| test/app-model-router.test.ts | test | kept | none | 150 | 0 | yes | app |
| test/app-model-settings.test.ts | test | kept | none | 20 | 0 | no | app |
| test/app-model-store.test.ts | test | src-unit | src | 393 | 2 | yes | app |
| test/app-model-strategy.test.ts | test | kept | none | 22 | 0 | yes | app |
| test/app-model-tasks.test.ts | test | src-unit | src | 63 | 2 | yes | app |
| test/app-model-thread.test.ts | test | kept | none | 76 | 0 | yes | app |
| test/app-model-wizard.test.ts | test | kept | none | 27 | 0 | yes | app |
| test/app-module-imports.test.ts | test | kept | none | 15 | 0 | no | app |
| test/app-narrow.test.tsx | test | src-unit | src | 182 | 1 | yes | app |
| test/app-native-chrome.test.ts | test | kept | none | 28 | 0 | no | app |
| test/app-navigation.test.tsx | test | kept | none | 32 | 0 | yes | app |
| test/app-needs-you-browser.test.ts | test | kept | none | 118 | 0 | no | app |
| test/app-needs-you.test.tsx | test | src-unit | src | 78 | 2 | yes | app |
| test/app-new-task-browser.test.tsx | test | kept | none | 488 | 0 | no | app |
| test/app-new-task.test.tsx | test | kept | none | 291 | 0 | yes | app |
| test/app-no-native-dialogs.test.ts | test | kept | none | 62 | 0 | no | app |
| test/app-notifications.test.tsx | test | kept | none | 34 | 0 | no | app |
| test/app-open-routes.test.ts | test | src-unit | src | 14 | 1 | yes | app |
| test/app-opencode-setup-screen.test.tsx | test | src-unit | src | 103 | 1 | yes | app |
| test/app-opencode-setup.test.ts | test | kept | none | 55 | 0 | yes | app |
| test/app-overview-pagination.test.ts | test | kept | none | 43 | 0 | no | app |
| test/app-pacing-browser.test.ts | test | kept | none | 86 | 0 | no | app |
| test/app-pacing-idle.test.ts | test | kept | none | 62 | 0 | yes | app |
| test/app-page-layout.test.tsx | test | kept | none | 35 | 0 | yes | app |
| test/app-panel-tabs.test.tsx | test | kept | none | 100 | 0 | yes | app |
| test/app-panels.test.tsx | test | kept | none | 163 | 0 | yes | app |
| test/app-pending-send-browser.test.tsx | test | kept | none | 29 | 0 | no | app |
| test/app-pending-send.test.tsx | test | kept | none | 198 | 0 | yes | app |
| test/app-planner-preview-keyboard.test.tsx | test | kept | none | 84 | 0 | no | app |
| test/app-platform-adapter.test.ts | test | src-unit | src | 110 | 1 | yes | app |
| test/app-plugin-runtime.test.tsx | test | kept | none | 75 | 0 | no | app |
| test/app-plugin-view.test.tsx | test | src-unit | src | 110 | 2 | yes | app |
| test/app-preferences-browser.test.tsx | test | kept | none | 113 | 0 | yes | app |
| test/app-project-strategies.test.tsx | test | src-unit | src | 86 | 1 | yes | app |
| test/app-query-browser.test.tsx | test | kept | none | 53 | 0 | no | app |
| test/app-query-cache-first.test.ts | test | kept | none | 90 | 0 | yes | app |
| test/app-query.test.ts | test | src-unit | src | 262 | 1 | yes | app |
| test/app-remedies-fix-all.test.ts | test | src-unit | src | 111 | 1 | yes | app |
| test/app-repo-chip-browser.test.tsx | test | kept | none | 49 | 0 | yes | app |
| test/app-repo-filter-browser.test.tsx | test | kept | none | 125 | 0 | no | app |
| test/app-retired-routes.test.ts | test | kept | none | 20 | 0 | no | app |
| test/app-review-bulk.test.tsx | test | src-unit | src | 232 | 3 | yes | app |
| test/app-review-model.test.ts | test | src-unit | src | 53 | 1 | yes | app |
| test/app-review-verdict.test.tsx | test | src-unit | src | 105 | 2 | yes | app |
| test/app-review.test.tsx | test | src-unit | src | 126 | 3 | yes | app |
| test/app-right-panel.test.tsx | test | kept | none | 67 | 0 | no | app |
| test/app-route-parity.test.ts | test | parity | parity | 40 | 2 | yes | app |
| test/app-routes-migrated.test.ts | test | kept | none | 10 | 0 | yes | app |
| test/app-screen-mounting.test.tsx | test | src-unit | src | 79 | 1 | yes | app |
| test/app-serve.test.ts | test | src-unit | src | 38 | 2 | yes | app |
| test/app-service-notifier.test.ts | test | src-unit | src | 464 | 1 | yes | app |
| test/app-session-board-browser.test.ts | test | kept | none | 40 | 0 | no | app |
| test/app-session-bundle.test.ts | test | src-unit | src | 26 | 2 | yes | app |
| test/app-session-client.test.ts | test | src-unit | src | 253 | 3 | yes | app |
| test/app-session-panel.test.tsx | test | src-unit | src | 151 | 1 | yes | app |
| test/app-session-recovery.test.ts | test | kept | none | 34 | 0 | yes | app |
| test/app-session-screen-browser.test.tsx | test | kept | none | 557 | 0 | no | app |
| test/app-session-screens.test.tsx | test | src-unit | src | 357 | 3 | yes | app |
| test/app-settings-6b-browser.test.ts | test | kept | none | 552 | 0 | no | app |
| test/app-settings-6b.test.tsx | test | src-unit | src | 292 | 1 | yes | app |
| test/app-settings-banners.test.tsx | test | kept | none | 183 | 0 | yes | app |
| test/app-settings-copy.test.tsx | test | src-unit | src | 152 | 6 | yes | app |
| test/app-settings-fidelity.test.tsx | test | kept | none | 77 | 0 | yes | app |
| test/app-settings-frame.test.tsx | test | src-unit | src | 578 | 1 | yes | app |
| test/app-settings-notifications.test.tsx | test | kept | none | 249 | 0 | yes | app |
| test/app-settings-pages.test.tsx | test | kept | none | 119 | 0 | yes | app |
| test/app-settings-plugins-pages.test.tsx | test | src-unit | src | 358 | 1 | yes | app |
| test/app-settings-plugins.test.tsx | test | kept | none | 224 | 0 | yes | app |
| test/app-settings-u3.test.tsx | test | src-unit | src | 428 | 3 | yes | app |
| test/app-setup-health-dom.ts | support | kept | none | 339 | 0 | no |  |
| test/app-setup-health-gate-browser.test.tsx | test | kept | none | 67 | 0 | no | app |
| test/app-setup-health-gate.test.tsx | test | src-unit | src | 559 | 2 | yes | app |
| test/app-setup-health.test.tsx | test | src-unit | src | 256 | 1 | yes | app |
| test/app-setup.test.tsx | test | src-unit | src | 275 | 3 | yes | app |
| test/app-shared-tabs.test.tsx | test | kept | none | 86 | 0 | no | app |
| test/app-shell-commands.test.ts | test | kept | none | 87 | 0 | no | app |
| test/app-shell-icon-canvas.test.tsx | test | kept | none | 51 | 0 | no | app |
| test/app-shell-panels.test.tsx | test | kept | none | 207 | 0 | yes | app |
| test/app-shell.test.tsx | test | src-unit | src | 176 | 1 | yes | app |
| test/app-skeleton-browser.test.ts | test | kept | none | 53 | 0 | no | app |
| test/app-sortable-browser.test.tsx | test | kept | none | 518 | 0 | no | app |
| test/app-spacing.test.tsx | test | src-unit | src | 115 | 1 | yes | app |
| test/app-start-session.test.tsx | test | kept | none | 91 | 0 | yes | app |
| test/app-states-browser.test.ts | test | kept | none | 259 | 0 | no | app |
| test/app-status-vocabulary.test.tsx | test | src-unit | src | 70 | 4 | yes | app |
| test/app-statusbar.test.tsx | test | src-unit | src | 175 | 2 | yes | app |
| test/app-store-invalidation.test.ts | test | kept | none | 179 | 0 | yes | app |
| test/app-takeover-rows.test.tsx | test | src-unit | src | 21 | 2 | yes | app |
| test/app-takeover.test.ts | test | kept | none | 72 | 0 | yes | app |
| test/app-task-answer-browser.test.tsx | test | kept | none | 76 | 0 | no | app |
| test/app-task-answer.test.tsx | test | src-unit | src | 73 | 2 | yes | app |
| test/app-task-file-counts.test.tsx | test | src-unit | src | 65 | 1 | yes | app |
| test/app-task-history-api.test.ts | test | kept | none | 30 | 0 | yes | app |
| test/app-task-result.test.tsx | test | src-unit | src | 101 | 1 | yes | app |
| test/app-task-tree.test.tsx | test | src-unit | src | 273 | 3 | yes | app |
| test/app-tasks-fidelity-live.test.ts | test | kept | none | 80 | 0 | no | app |
| test/app-tasks-layout.test.tsx | test | src-unit | src | 250 | 4 | yes | app |
| test/app-tasks-page.test.tsx | test | src-unit | src | 226 | 1 | yes | app |
| test/app-terminal-action-request.test.ts | test | kept | none | 48 | 0 | yes | app |
| test/app-terminal-auto-open.test.ts | test | src-unit | src | 34 | 1 | yes | app |
| test/app-terminal-browser.test.ts | test | src-unit | src | 50 | 1 | yes | app |
| test/app-terminal-browser.test.tsx | test | kept | none | 213 | 0 | no | app |
| test/app-terminal-exit.test.ts | test | kept | none | 57 | 0 | yes | app |
| test/app-terminal-panel-live.test.ts | test | src-unit | src | 69 | 1 | yes | app |
| test/app-terminal-request.test.ts | test | kept | none | 16 | 0 | no | app |
| test/app-terminal-route.test.ts | test | kept | none | 14 | 0 | yes | app |
| test/app-terminal-runtime.test.ts | test | kept | none | 68 | 0 | yes | app |
| test/app-terminal-screen.test.tsx | test | kept | none | 12 | 0 | yes | app |
| test/app-terminal-security.test.ts | test | src-unit | src | 16 | 1 | yes | app |
| test/app-theme.test.ts | test | kept | none | 22 | 0 | no | app |
| test/app-thread.test.tsx | test | src-unit | src | 85 | 1 | yes | app |
| test/app-tier-targets.test.ts | test | src-unit | src | 199 | 2 | yes | app |
| test/app-tokens.test.ts | test | kept | none | 125 | 0 | yes | app |
| test/app-topbar-shortcuts.test.tsx | test | kept | none | 21 | 0 | yes | app |
| test/app-topbar.test.tsx | test | src-unit | src | 75 | 1 | yes | app |
| test/app-trace-answer-browser.test.tsx | test | kept | none | 57 | 0 | no | app |
| test/app-trace-browser.test.ts | test | kept | none | 156 | 0 | no | app |
| test/app-trace-preview-browser.test.tsx | test | kept | none | 42 | 0 | no | app |
| test/app-trace-tier.test.tsx | test | src-unit | src | 20 | 2 | yes | app |
| test/app-tray-board-browser.test.ts | test | kept | none | 154 | 0 | yes | app |
| test/app-tray-layout-browser.test.ts | test | kept | none | 516 | 0 | yes | app |
| test/app-tray.test.tsx | test | src-unit | src | 574 | 5 | yes | app |
| test/app-update-notice.test.tsx | test | src-unit | src | 150 | 1 | yes | app |
| test/app-update-poll-browser.test.tsx | test | kept | none | 52 | 0 | yes | app |
| test/app-update-restart.test.tsx | test | src-unit | src | 36 | 1 | yes | app |
| test/app-usage-refresh-browser.test.tsx | test | kept | none | 137 | 0 | yes | app |
| test/app-ux-fixes.test.ts | test | src-unit | src | 78 | 6 | yes | app |
| test/app-ux-round2.test.ts | test | src-unit | src | 49 | 1 | yes | app |
| test/app-view-host.test.tsx | test | kept | none | 174 | 0 | yes | app |
| test/app-window-corners-browser.test.ts | test | kept | none | 101 | 0 | no | app |
| test/app-work-action-id.test.ts | test | kept | none | 12 | 0 | yes | app |
| test/app-work-focus-browser.test.tsx | test | kept | none | 55 | 0 | no | app |
| test/app-workspace-answer-browser.test.tsx | test | kept | none | 186 | 0 | no | app |
| test/app-workspace-browser.test.ts | test | kept | none | 691 | 0 | no | app |
| test/app-workspace-initial-live.test.ts | test | kept | none | 105 | 0 | no | app |
| test/app-workspace-label.test.ts | test | kept | none | 60 | 0 | yes | app |
| test/app-workspace-manager.test.ts | test | kept | none | 71 | 0 | yes | app |
| test/app-workspace-routing.test.tsx | test | src-unit | src | 126 | 8 | yes | app |
| test/app-workspace-terminal-browser.test.ts | test | kept | none | 326 | 0 | no | app |
| test/ask.test.ts | test | src-unit | src | 71 | 6 | yes | ask.test.ts |
| test/assistant-api.test.ts | test | src-unit | src | 151 | 9 | yes | assistant |
| test/assistant-claude-control.test.ts | test | src-unit | src | 400 | 1 | yes | assistant |
| test/assistant-core.test.ts | test | src-unit | src | 203 | 6 | yes | assistant |
| test/assistant-executor.test.ts | test | plugin | plugin | 1078 | 15 | yes | assistant |
| test/assistant-grant.test.ts | test | src-unit | src | 318 | 18 | yes | assistant |
| test/assistant-plugin.test.ts | test | plugin | plugin | 73 | 4 | yes | assistant |
| test/assistant-reply.test.ts | test | src-unit | src | 762 | 18 | yes | assistant |
| test/assistant-service.test.ts | test | src-unit | src | 159 | 6 | yes | assistant |
| test/attachments-http.test.ts | test | src-unit | src | 24 | 3 | yes | attachments |
| test/attachments-store.test.ts | test | src-unit | src | 42 | 2 | yes | attachments |
| test/attention-rules.test.ts | test | src-unit | src | 160 | 5 | yes | attention |
| test/attention-store.test.ts | test | src-unit | src | 43 | 4 | yes | attention |
| test/autoconsole-worker.test.ts | test | src-unit | src | 9 | 1 | yes | autoconsole |
| test/backend.test.ts | test | src-unit | src | 213 | 9 | yes | backend.test.ts |
| test/balance.test.ts | test | src-unit | src | 145 | 5 | yes | balance.test.ts |
| test/bench-metrics.test.ts | test | src-unit | src | 93 | 2 | yes | bench |
| test/bench.test.ts | test | plugin | plugin | 175 | 10 | yes | bench.test.ts |
| test/build-core-compiled.test.ts | test | src-unit | src | 34 | 1 | yes | build |
| test/build-version.test.ts | test | kept | none | 57 | 0 | yes | build |
| test/byteplus.test.ts | test | src-unit | src | 75 | 2 | yes | byteplus.test.ts |
| test/cache.test.ts | test | src-unit | src | 33 | 2 | yes | cache.test.ts |
| test/caller-policy.test.ts | test | src-unit | src | 292 | 10 | yes | caller |
| test/child-env.test.ts | test | kept | none | 26 | 0 | no | child |
| test/child-env.ts | support | kept | none | 42 | 0 | no |  |
| test/ci-selection.test.ts | test | kept | none | 227 | 0 | no | ci |
| test/ci-service-survival.test.ts | test | kept | none | 26 | 0 | no | ci |
| test/ci-sharding.test.ts | test | binary-e2e | e2e | 172 | 0 | no | ci |
| test/classify-config.test.ts | test | src-unit | src | 109 | 2 | yes | classify |
| test/classify-decide.test.ts | test | plugin | plugin | 230 | 8 | yes | classify |
| test/classify-hooks.test.ts | test | plugin | plugin | 189 | 9 | yes | classify |
| test/classify-jev.test.ts | test | plugin | plugin | 203 | 7 | yes | classify |
| test/classify-ollama.test.ts | test | plugin | plugin | 127 | 6 | yes | classify |
| test/classify-rules.test.ts | test | plugin | plugin | 132 | 2 | yes | classify |
| test/classify-state.test.ts | test | plugin | plugin | 178 | 8 | yes | classify |
| test/classify-truth.test.ts | test | src-unit | src | 208 | 10 | yes | classify |
| test/claude-managed-telemetry.test.ts | test | src-unit | src | 53 | 2 | yes | claude |
| test/claude-trust.test.ts | test | src-unit | src | 181 | 1 | yes | claude |
| test/claude.test.ts | test | src-unit | src | 113 | 2 | yes | claude.test.ts |
| test/cli-guard-parity.test.ts | test | parity | parity | 374 | 5 | yes | cli |
| test/cli-interface.test.ts | test | src-unit | src | 107 | 7 | yes | cli |
| test/cli-native-bootstrap.test.ts | test | src-unit | src | 20 | 1 | yes | cli |
| test/cli-output-flush.test.ts | test | binary-e2e | e2e | 30 | 0 | no | cli |
| test/cli-review-request.test.ts | test | src-unit | src | 16 | 2 | yes | cli |
| test/cli-usage-refresh.test.ts | test | src-unit | src | 20 | 2 | yes | cli |
| test/cli-watch.test.ts | test | binary-e2e | e2e | 155 | 3 | yes | cli |
| test/cli.test.ts | test | src-unit | src | 240 | 7 | yes | cli.test.ts |
| test/client-control.test.ts | test | src-unit | src | 38 | 1 | yes | client |
| test/clients.test.ts | test | src-unit | src | 229 | 3 | yes | clients.test.ts |
| test/clock.test.ts | test | src-unit | src | 41 | 2 | yes | clock.test.ts |
| test/codex.test.ts | test | src-unit | src | 126 | 1 | yes | codex.test.ts |
| test/commands-account-opencode.test.ts | test | src-unit | src | 42 | 3 | yes | commands |
| test/commands-account-picker.test.ts | test | src-unit | src | 86 | 3 | yes | commands |
| test/commands-account-wizard.test.ts | test | src-unit | src | 207 | 4 | yes | commands |
| test/commands-accounts.test.ts | test | src-unit | src | 222 | 5 | yes | commands |
| test/commands-api.test.ts | test | src-unit | src | 68 | 2 | yes | commands |
| test/commands-attachments.test.ts | test | src-unit | src | 30 | 1 | yes | commands |
| test/commands-config.test.ts | test | src-unit | src | 104 | 6 | yes | commands |
| test/commands-endpoint.test.ts | test | src-unit | src | 254 | 7 | yes | commands |
| test/commands-session-io.test.ts | test | src-unit | src | 63 | 2 | yes | commands |
| test/commands.test.ts | test | src-unit | src | 63 | 4 | yes | commands.test.ts |
| test/compiled-workers.test.ts | test | src-unit | src | 78 | 1 | yes | compiled |
| test/config-accounts.test.ts | test | src-unit | src | 149 | 4 | yes | config |
| test/config-edit.test.ts | test | src-unit | src | 80 | 1 | yes | config |
| test/config-executor-settings-differential.test.ts | test | parity | parity | 66 | 1 | yes | config |
| test/config-host-differential.test.ts | test | parity | parity | 166 | 3 | yes | config |
| test/config-hosts.test.ts | test | src-unit | src | 78 | 3 | yes | config |
| test/config-migrate.test.ts | test | src-unit | src | 168 | 7 | yes | config |
| test/config-opencode-accounts.test.ts | test | src-unit | src | 71 | 1 | yes | config |
| test/config-pacing-probe.test.ts | test | src-unit | src | 93 | 2 | yes | config |
| test/config-settings-parity.test.ts | test | parity | parity | 37 | 2 | yes | config |
| test/config-strategy-doc-golden.test.ts | test | kept | none | 50 | 0 | yes | config |
| test/config-write-differential.test.ts | test | parity | parity | 670 | 8 | yes | config |
| test/console-cli.test.ts | test | src-unit | src | 61 | 2 | yes | console |
| test/console-settings.test.ts | test | binary-e2e | e2e | 115 | 7 | yes | console |
| test/core-auto-migrate.test.ts | test | src-unit | src | 125 | 6 | yes | core |
| test/core-boundaries.test.ts | test | kept | none | 74 | 0 | no | core |
| test/core-clean.test.ts | test | src-unit | src | 812 | 20 | yes | core |
| test/core-evidence.test.ts | test | src-unit | src | 111 | 7 | yes | core |
| test/core-lock.test.ts | test | src-unit | src | 101 | 1 | yes | core |
| test/core-log-diff.test.ts | test | src-unit | src | 109 | 3 | yes | core |
| test/core-opencode-setup.test.ts | test | src-unit | src | 137 | 5 | yes | core |
| test/core-runner-models-set-many.test.ts | test | src-unit | src | 139 | 3 | yes | core |
| test/core-runners.test.ts | test | src-unit | src | 68 | 5 | yes | core |
| test/core-secrets-environ.test.ts | test | parity | parity | 70 | 1 | yes | core |
| test/core-secrets-frame.test.ts | test | parity | parity | 211 | 1 | yes | core |
| test/core-secrets-paired.test.ts | test | kept | none | 15 | 0 | no | core |
| test/core-tasks-diff.test.ts | test | src-unit | src | 147 | 5 | yes | core |
| test/core-tasks-list.test.ts | test | src-unit | src | 487 | 11 | yes | core |
| test/core-tasks.test.ts | test | src-unit | src | 253 | 9 | yes | core |
| test/core-tier-targets.test.ts | test | src-unit | src | 130 | 3 | yes | core |
| test/crate-publishing.test.ts | test | kept | none | 135 | 0 | yes | crate |
| test/ctx.test.ts | test | src-unit | src | 41 | 2 | yes | ctx.test.ts |
| test/dashboard-cli.test.ts | test | src-unit | src | 32 | 2 | yes | dashboard |
| test/dashboard-controller.test.ts | test | src-unit | src | 524 | 9 | yes | dashboard |
| test/dashboard-data.test.ts | test | src-unit | src | 109 | 6 | yes | dashboard |
| test/dashboard-frame-parity.test.ts | test | parity | parity | 41 | 2 | yes | dashboard |
| test/dashboard-frame.test.ts | test | src-unit | src | 70 | 2 | yes | dashboard |
| test/dashboard-imports.test.ts | test | kept | none | 58 | 0 | no | dashboard |
| test/dashboard-managed-root.test.ts | test | src-unit | src | 78 | 8 | yes | dashboard |
| test/dashboard-notifier.test.ts | test | src-unit | src | 105 | 2 | yes | dashboard |
| test/dashboard-panel-semantics.test.ts | test | src-unit | src | 54 | 3 | yes | dashboard |
| test/dashboard-screens.test.ts | test | src-unit | src | 696 | 12 | yes | dashboard |
| test/dashboard-state.test.ts | test | src-unit | src | 117 | 2 | yes | dashboard |
| test/dashboard-theme.test.ts | test | src-unit | src | 86 | 1 | yes | dashboard |
| test/dashboard-thread.test.ts | test | src-unit | src | 76 | 9 | yes | dashboard |
| test/delegate-difficulty.test.ts | test | src-unit | src | 100 | 6 | yes | delegate |
| test/delegate-ui.test.ts | test | src-unit | src | 100 | 5 | yes | delegate |
| test/density-preference.test.ts | test | kept | none | 20 | 0 | no | density |
| test/desktop-archive.test.ts | test | kept | none | 54 | 0 | yes | desktop |
| test/desktop-bootstrap-identity.test.ts | test | src-unit | src | 38 | 1 | yes | desktop |
| test/desktop-capture-api.test.ts | test | src-unit | src | 132 | 8 | yes | desktop |
| test/desktop-credentials.test.ts | test | kept | none | 149 | 0 | yes | desktop |
| test/desktop-disk-image.test.ts | test | kept | none | 58 | 0 | yes | desktop |
| test/desktop-feed-fixture.test.ts | test | kept | none | 31 | 0 | yes | desktop |
| test/desktop-feed.test.ts | test | kept | none | 260 | 0 | yes | desktop |
| test/desktop-linux-pair.test.ts | test | kept | none | 104 | 0 | yes | desktop |
| test/desktop-native-paired-bootstrap.test.ts | test | src-unit | src | 119 | 1 | yes | desktop |
| test/desktop-native-parent-channels.test.ts | test | kept | none | 18 | 0 | yes | desktop |
| test/desktop-native-provider-owner.test.ts | test | src-unit | src | 303 | 13 | yes | desktop |
| test/desktop-native-service-owner.test.ts | test | src-unit | src | 61 | 1 | yes | desktop |
| test/desktop-package.test.ts | test | kept | none | 192 | 0 | yes | desktop |
| test/desktop-publisher.test.ts | test | kept | none | 69 | 0 | yes | desktop |
| test/desktop-reconciliation-admission.test.ts | test | src-unit | src | 152 | 3 | yes | desktop |
| test/desktop-reconciliation-coordinator.test.ts | test | src-unit | src | 165 | 3 | yes | desktop |
| test/desktop-reconciliation-identity.test.ts | test | src-unit | src | 83 | 4 | yes | desktop |
| test/desktop-release-build.test.ts | test | src-unit | src | 40 | 1 | yes | desktop |
| test/desktop-release-cli.test.ts | test | kept | none | 97 | 0 | yes | desktop |
| test/desktop-release-workflow.test.ts | test | kept | none | 63 | 0 | no | desktop |
| test/desktop-self-signed-authority.test.ts | test | src-unit | src | 44 | 1 | yes | desktop |
| test/desktop-shell.test.ts | test | kept | none | 695 | 0 | no | desktop |
| test/desktop-sign.test.ts | test | kept | none | 308 | 0 | yes | desktop |
| test/desktop-signer-requirement.test.ts | test | src-unit | src | 22 | 1 | yes | desktop |
| test/desktop-stage-cli.test.ts | test | binary-e2e | e2e | 75 | 0 | yes | desktop |
| test/desktop-update-adapter.test.ts | test | src-unit | src | 356 | 2 | yes | desktop |
| test/desktop-update-admission.test.ts | test | src-unit | src | 312 | 14 | yes | desktop |
| test/desktop-update-adoption.test.ts | test | src-unit | src | 806 | 15 | yes | desktop |
| test/desktop-update-bootout-observation.test.ts | test | kept | none | 84 | 0 | yes | desktop |
| test/desktop-update-bundle-identity.test.ts | test | src-unit | src | 82 | 5 | yes | desktop |
| test/desktop-update-claim-ownership.test.ts | test | src-unit | src | 10 | 1 | yes | desktop |
| test/desktop-update-command.test.ts | test | src-unit | src | 51 | 2 | yes | desktop |
| test/desktop-update-fixture-cleanup.test.ts | test | src-unit | src | 20 | 2 | yes | desktop |
| test/desktop-update-helper-channel.test.ts | test | kept | none | 11 | 0 | no | desktop |
| test/desktop-update-helper-failure.test.ts | test | kept | none | 9 | 0 | no | desktop |
| test/desktop-update-helper-receipt.test.ts | test | kept | none | 11 | 0 | no | desktop |
| test/desktop-update-identity.test.ts | test | src-unit | src | 148 | 3 | yes | desktop |
| test/desktop-update-native-compiled.test.ts | test | src-unit | src | 52 | 1 | yes | desktop |
| test/desktop-update-native-shim.test.ts | test | src-unit | src | 24 | 3 | yes | desktop |
| test/desktop-update-native.test.ts | test | src-unit | src | 964 | 39 | yes | desktop |
| test/desktop-update-state.test.ts | test | src-unit | src | 303 | 4 | yes | desktop |
| test/desktop-update-verification-cache.test.ts | test | src-unit | src | 29 | 1 | yes | desktop |
| test/desktop-validation-ipc.test.ts | test | kept | none | 12 | 0 | yes | desktop |
| test/direct.test.ts | test | binary-e2e | e2e | 274 | 11 | yes | direct.test.ts |
| test/discovery-attention.test.ts | test | src-unit | src | 96 | 6 | yes | discovery |
| test/discovery-cli.test.ts | test | src-unit | src | 138 | 11 | yes | discovery |
| test/discovery-network.test.ts | test | src-unit | src | 288 | 2 | yes | discovery |
| test/discovery-ops.test.ts | test | src-unit | src | 243 | 16 | yes | discovery |
| test/discovery-radio.test.ts | test | src-unit | src | 326 | 9 | yes | discovery |
| test/discovery-state.test.ts | test | src-unit | src | 98 | 2 | yes | discovery |
| test/dismiss-store-parity.test.ts | test | parity | parity | 37 | 1 | yes | dismiss |
| test/dispatch-actual-model.test.ts | test | src-unit | src | 8 | 1 | yes | dispatch |
| test/dispatch-api.test.ts | test | src-unit | src | 131 | 9 | yes | dispatch |
| test/dispatch-certification-consent.test.ts | test | src-unit | src | 352 | 4 | yes | dispatch |
| test/dispatch-certification-reason.test.ts | test | src-unit | src | 318 | 10 | yes | dispatch |
| test/dispatch-certification-schedule.test.ts | test | src-unit | src | 332 | 1 | yes | dispatch |
| test/dispatch-certification-tick.test.ts | test | src-unit | src | 604 | 8 | yes | dispatch |
| test/dispatch-cli.test.ts | test | src-unit | src | 10 | 1 | yes | dispatch |
| test/dispatch-config.test.ts | test | src-unit | src | 30 | 3 | yes | dispatch |
| test/dispatch-decision-parity.test.ts | test | parity | parity | 470 | 11 | yes | dispatch |
| test/dispatch-delegation.test.ts | test | src-unit | src | 48 | 4 | yes | dispatch |
| test/dispatch-enforcement-certification.test.ts | test | src-unit | src | 91 | 3 | yes | dispatch |
| test/dispatch-enforcement-token.test.ts | test | src-unit | src | 43 | 5 | yes | dispatch |
| test/dispatch-engines.test.ts | test | src-unit | src | 32 | 1 | yes | dispatch |
| test/dispatch-explain-parity.test.ts | test | parity | parity | 474 | 23 | yes | dispatch |
| test/dispatch-explain.test.ts | test | src-unit | src | 402 | 22 | yes | dispatch |
| test/dispatch-grant-http.test.ts | test | src-unit | src | 43 | 5 | yes | dispatch |
| test/dispatch-ladder.test.ts | test | src-unit | src | 113 | 4 | yes | dispatch |
| test/dispatch-learning.test.ts | test | src-unit | src | 45 | 4 | yes | dispatch |
| test/dispatch-observations.test.ts | test | src-unit | src | 38 | 4 | yes | dispatch |
| test/dispatch-parts-bridge.test.ts | test | src-unit | src | 193 | 9 | yes | dispatch |
| test/dispatch-refresh.test.ts | test | src-unit | src | 28 | 3 | yes | dispatch |
| test/dispatch-runtime.test.ts | test | src-unit | src | 116 | 28 | yes | dispatch |
| test/dispatch-tier-select.test.ts | test | src-unit | src | 63 | 2 | yes | dispatch |
| test/dispatch-tier-targets.test.ts | test | parity | parity | 64 | 1 | yes | dispatch |
| test/dispatch-tui.test.ts | test | src-unit | src | 56 | 6 | yes | dispatch |
| test/dispatch-work.test.ts | test | src-unit | src | 280 | 9 | yes | dispatch |
| test/docs-service-upgrade.test.ts | test | src-unit | src | 25 | 1 | yes | docs |
| test/doctor-error-codes.test.ts | test | src-unit | src | 111 | 3 | yes | doctor |
| test/doctor-executor-models.test.ts | test | src-unit | src | 160 | 4 | yes | doctor |
| test/doctor-fix-delegate.test.ts | test | src-unit | src | 297 | 10 | yes | doctor |
| test/doctor-hooks.test.ts | test | plugin | plugin | 178 | 10 | yes | doctor |
| test/doctor-host-socket.test.ts | test | src-unit | src | 69 | 1 | yes | doctor |
| test/doctor-notifications.test.ts | test | src-unit | src | 165 | 5 | yes | doctor |
| test/doctor-remedies.test.ts | test | src-unit | src | 257 | 9 | yes | doctor |
| test/doctor-removable.test.ts | test | src-unit | src | 25 | 1 | yes | doctor |
| test/drain.test.ts | test | src-unit | src | 203 | 6 | yes | drain.test.ts |
| test/e2e.test.ts | test | kept | none | 73 | 0 | yes | e2e.test.ts |
| test/eligibility.test.ts | test | src-unit | src | 206 | 3 | yes | eligibility.test.ts |
| test/endpoint-catalog.test.ts | test | src-unit | src | 50 | 1 | yes | endpoint |
| test/endpoint-connection.test.ts | test | src-unit | src | 42 | 2 | yes | endpoint |
| test/endpoint-detect.test.ts | test | src-unit | src | 138 | 5 | yes | endpoint |
| test/endpoint-discovery-fixtures.ts | support | plugin | plugin | 18 | 1 | yes |  |
| test/endpoint-keys.test.ts | test | src-unit | src | 114 | 1 | yes | endpoint |
| test/endpoint-models.test.ts | test | src-unit | src | 69 | 3 | yes | endpoint |
| test/endpoint-opencode-config.test.ts | test | plugin | plugin | 170 | 6 | yes | endpoint |
| test/endpoint-recommend.test.ts | test | src-unit | src | 52 | 2 | yes | endpoint |
| test/endpoint-test-task.test.ts | test | src-unit | src | 83 | 6 | yes | endpoint |
| test/engine-accounts.test.ts | test | src-unit | src | 254 | 7 | yes | engine |
| test/engine-evidence.test.ts | test | src-unit | src | 285 | 3 | yes | engine |
| test/engine-golden.test.ts | test | kept | none | 44 | 0 | yes | engine |
| test/engine-golden.ts | support | src-unit | src | 222 | 11 | yes |  |
| test/events-replay-index.test.ts | test | src-unit | src | 227 | 7 | yes | events |
| test/events-replay-performance.test.ts | test | src-unit | src | 71 | 6 | yes | events |
| test/exec-accounts.test.ts | test | src-unit | src | 153 | 7 | yes | exec |
| test/exec-process-jsonrpc.test.ts | test | src-unit | src | 17 | 1 | yes | exec |
| test/execution-evidence.test.ts | test | src-unit | src | 39 | 4 | yes | execution |
| test/executor-availability.test.ts | test | src-unit | src | 98 | 8 | yes | executor |
| test/executor-block.test.ts | test | src-unit | src | 66 | 10 | yes | executor |
| test/executor-connect-denial.test.ts | test | src-unit | src | 53 | 4 | yes | executor |
| test/executor-role.test.ts | test | src-unit | src | 63 | 4 | yes | executor |
| test/executor-session-limit.test.ts | test | src-unit | src | 203 | 7 | yes | executor |
| test/executor-settings.test.ts | test | src-unit | src | 47 | 2 | yes | executor |
| test/failure-lifecycle.test.ts | test | src-unit | src | 74 | 7 | yes | failure |
| test/fake-keychain.ts | support | src-unit | src | 47 | 1 | yes |  |
| test/files-search-parity.test.ts | test | parity | parity | 138 | 4 | yes | files |
| test/files-search.test.ts | test | src-unit | src | 254 | 6 | yes | files |
| test/fixture-cleanup.test.ts | test | kept | none | 54 | 0 | yes | fixture |
| test/fixture-cleanup.ts | support | kept | none | 17 | 0 | no |  |
| test/fixtures/account-usage-browser.tsx | support | kept | none | 22 | 0 | yes |  |
| test/fixtures/agent-core.ts | support | src-unit | src | 48 | 6 | yes |  |
| test/fixtures/app-assistant-browser.tsx | support | kept | none | 93 | 0 | yes |  |
| test/fixtures/app-assistant-settings-browser.tsx | support | kept | none | 77 | 0 | yes |  |
| test/fixtures/app-cache-first.tsx | support | kept | none | 14 | 0 | yes |  |
| test/fixtures/app-frame-browser.tsx | support | kept | none | 73 | 0 | yes |  |
| test/fixtures/app-new-task-browser.tsx | support | kept | none | 100 | 0 | yes |  |
| test/fixtures/app-preferences-browser.tsx | support | kept | none | 31 | 0 | yes |  |
| test/fixtures/app-query-browser.tsx | support | kept | none | 35 | 0 | yes |  |
| test/fixtures/app-view-host-browser.tsx | support | kept | none | 31 | 0 | yes |  |
| test/fixtures/app-view-host-status.tsx | support | kept | none | 4 | 0 | yes |  |
| test/fixtures/app-view-lifecycle.tsx | support | kept | none | 18 | 0 | yes |  |
| test/fixtures/assistant-pacer/peer.ts | support | kept | none | 101 | 0 | no |  |
| test/fixtures/assistant-reply/peer.ts | support | kept | none | 123 | 0 | no |  |
| test/fixtures/background-worker-probe.ts | support | src-unit | src | 23 | 1 | yes |  |
| test/fixtures/balance-pair.ts | support | src-unit | src | 14 | 1 | yes |  |
| test/fixtures/classifier-generation/peer.ts | support | plugin | plugin | 22 | 0 | no |  |
| test/fixtures/core-discover-plan.ts | support | src-unit | src | 29 | 1 | yes |  |
| test/fixtures/core-stdin-proxy.ts | support | kept | none | 39 | 0 | yes |  |
| test/fixtures/dashboard-frame/cases.ts | support | src-unit | src | 277 | 9 | yes |  |
| test/fixtures/dashboard-frame/generate.ts | support | kept | none | 7 | 0 | yes |  |
| test/fixtures/dashboard-frame/semantics.ts | support | src-unit | src | 33 | 4 | yes |  |
| test/fixtures/desktop-update/admission-worker.ts | support | src-unit | src | 25 | 3 | yes |  |
| test/fixtures/desktop-update/compiled-identity.ts | support | src-unit | src | 11 | 4 | yes |  |
| test/fixtures/desktop-update/compiled-socket.ts | support | src-unit | src | 10 | 2 | yes |  |
| test/fixtures/desktop-update/helper-channel-client.ts | support | src-unit | src | 13 | 1 | yes |  |
| test/fixtures/desktop-update/state-worker.ts | support | src-unit | src | 23 | 3 | yes |  |
| test/fixtures/desktop-update/status.ts | support | src-unit | src | 8 | 1 | yes |  |
| test/fixtures/diagnostics-browser.tsx | support | kept | none | 23 | 0 | yes |  |
| test/fixtures/diagnostics-restart-browser.tsx | support | kept | none | 23 | 0 | yes |  |
| test/fixtures/dispatch.ts | support | src-unit | src | 9 | 1 | yes |  |
| test/fixtures/eligibility.ts | support | src-unit | src | 9 | 1 | yes |  |
| test/fixtures/endpoint-test-fixtures.ts | support | plugin | plugin | 23 | 5 | yes |  |
| test/fixtures/endpoint-write/credential-peer.ts | support | plugin | plugin | 6 | 0 | no |  |
| test/fixtures/endpoint-write/peer.ts | support | kept | none | 20 | 0 | no |  |
| test/fixtures/failure-review-browser.tsx | support | kept | none | 27 | 0 | yes |  |
| test/fixtures/git-isolation-probe.ts | support | src-unit | src | 39 | 1 | yes |  |
| test/fixtures/history-parent.ts | support | binary-e2e | e2e | 22 | 2 | yes |  |
| test/fixtures/host-broker/caller.ts | support | kept | none | 39 | 0 | no |  |
| test/fixtures/host-check-clean-core.ts | support | src-unit | src | 52 | 4 | yes |  |
| test/fixtures/http-registry/legacy-peer.ts | support | kept | none | 9 | 0 | no |  |
| test/fixtures/http-registry/sdk-peer.ts | support | kept | none | 13 | 0 | no |  |
| test/fixtures/immediate-save-browser.tsx | support | kept | none | 21 | 0 | yes |  |
| test/fixtures/install-apply-core.ts | support | src-unit | src | 78 | 6 | yes |  |
| test/fixtures/live/cleanup-capture-process.ts | support | src-unit | src | 44 | 2 | yes |  |
| test/fixtures/live/cleanup-process-tree.ts | support | kept | none | 42 | 0 | no |  |
| test/fixtures/live/cleanup-startup.ts | support | binary-e2e | e2e | 187 | 1 | yes |  |
| test/fixtures/live/ota-control-evidence.ts | support | kept | none | 37 | 0 | yes |  |
| test/fixtures/machine-browser.tsx | support | kept | none | 26 | 0 | yes |  |
| test/fixtures/mcp/rust-backend.ts | support | src-unit | src | 58 | 3 | yes |  |
| test/fixtures/mcp/rust-stdio.ts | support | parity | parity | 15 | 1 | yes |  |
| test/fixtures/native-helper-timing-peer.ts | support | kept | none | 18 | 0 | no |  |
| test/fixtures/native-host-parity/core.ts | support | binary-e2e | e2e | 22 | 1 | yes |  |
| test/fixtures/native-listener-handoff.ts | support | src-unit | src | 56 | 2 | yes |  |
| test/fixtures/native-owner-relay.ts | support | parity | parity | 107 | 0 | yes |  |
| test/fixtures/notifier-config/peer.ts | support | plugin | plugin | 15 | 0 | no |  |
| test/fixtures/orca-text-parity.ts | support | parity | parity | 8 | 1 | yes |  |
| test/fixtures/orca/fake.ts | support | src-unit | src | 46 | 1 | yes |  |
| test/fixtures/orca/in-process.ts | support | plugin | plugin | 51 | 7 | yes |  |
| test/fixtures/owner-auth.ts | support | src-unit | src | 58 | 1 | yes |  |
| test/fixtures/p6e/cases.ts | support | kept | none | 995 | 0 | no |  |
| test/fixtures/p6e/reference.ts | support | src-unit | src | 520 | 2 | yes |  |
| test/fixtures/pacing-browser.tsx | support | kept | none | 19 | 0 | yes |  |
| test/fixtures/panel-tabs-browser.tsx | support | kept | none | 12 | 0 | yes |  |
| test/fixtures/parity-native-peer.ts | support | parity | parity | 7 | 0 | no |  |
| test/fixtures/parity-peer.ts | support | parity | parity | 68 | 0 | no |  |
| test/fixtures/parity-stdin-ready.ts | support | parity | parity | 25 | 0 | no |  |
| test/fixtures/pending-send-browser.tsx | support | kept | none | 17 | 0 | yes |  |
| test/fixtures/plugin-error-reason/peer.ts | support | kept | none | 8 | 0 | no |  |
| test/fixtures/plugin-http-transfer-effects.ts | support | src-unit | src | 37 | 3 | yes |  |
| test/fixtures/plugin-stream-peer.ts | support | kept | none | 60 | 0 | no |  |
| test/fixtures/plugin-transfer-effects.ts | support | src-unit | src | 24 | 2 | yes |  |
| test/fixtures/policy-host.ts | support | src-unit | src | 19 | 1 | yes |  |
| test/fixtures/policy-observations/raw.ts | support | kept | none | 40 | 0 | no |  |
| test/fixtures/policy-observations/sdk.ts | support | kept | none | 12 | 0 | no |  |
| test/fixtures/process-environ.ts | support | kept | none | 55 | 0 | no |  |
| test/fixtures/protocol-v2/capture.ts | support | src-unit | src | 64 | 6 | yes |  |
| test/fixtures/protocol-v2/characterize.ts | support | src-unit | src | 443 | 4 | yes |  |
| test/fixtures/pump-checkpoint-worker.ts | support | src-unit | src | 23 | 3 | yes |  |
| test/fixtures/remote-eligibility.ts | support | src-unit | src | 30 | 1 | yes |  |
| test/fixtures/repo-filter-browser.tsx | support | src-unit | src | 32 | 1 | yes |  |
| test/fixtures/runner-check-core.ts | support | src-unit | src | 60 | 6 | yes |  |
| test/fixtures/serve-fifo.ts | support | src-unit | src | 66 | 5 | yes |  |
| test/fixtures/serve-health-block.ts | support | src-unit | src | 11 | 1 | yes |  |
| test/fixtures/serve-help-guard.ts | support | kept | none | 18 | 0 | no |  |
| test/fixtures/session-screen-browser.tsx | support | kept | none | 83 | 0 | yes |  |
| test/fixtures/session/fault-runner.ts | support | src-unit | src | 11 | 2 | yes |  |
| test/fixtures/sessions/cli-branches.ts | support | src-unit | src | 94 | 4 | yes |  |
| test/fixtures/shared-tabs-browser.tsx | support | kept | none | 11 | 0 | yes |  |
| test/fixtures/sp-forge/install.ts | support | kept | none | 36 | 0 | no |  |
| test/fixtures/sp-moved-tamper/install.ts | support | kept | none | 36 | 0 | no |  |
| test/fixtures/sp-tamper/install.ts | support | kept | none | 32 | 0 | no |  |
| test/fixtures/sp02-rpc/budget-peer.ts | support | kept | none | 9 | 0 | no |  |
| test/fixtures/sp02-rpc/capability-budget.ts | support | src-unit | src | 28 | 2 | yes |  |
| test/fixtures/sp02-rpc/chunk-peer.ts | support | kept | none | 27 | 0 | no |  |
| test/fixtures/sp02-rpc/method-serialization.ts | support | src-unit | src | 23 | 2 | yes |  |
| test/fixtures/sp02-rpc/peer.ts | support | kept | none | 41 | 0 | no |  |
| test/fixtures/sp02-rpc/sdk-peer.ts | support | kept | none | 5 | 0 | no |  |
| test/fixtures/sp02-security/legacy-plugin.ts | support | kept | none | 31 | 0 | no |  |
| test/fixtures/sp06-rpc/chunks.ts | support | kept | none | 40 | 0 | no |  |
| test/fixtures/sp06-rpc/command.ts | support | kept | none | 25 | 0 | no |  |
| test/fixtures/sp06-rpc/install.ts | support | kept | none | 43 | 0 | no |  |
| test/fixtures/sp06-rpc/large-result.ts | support | kept | none | 16 | 0 | no |  |
| test/fixtures/sp06-rpc/late.ts | support | kept | none | 32 | 0 | no |  |
| test/fixtures/sp06-rpc/parent.ts | support | src-unit | src | 73 | 6 | yes |  |
| test/fixtures/sp06-rpc/read.ts | support | kept | none | 19 | 0 | no |  |
| test/fixtures/streamlocal-forward.ts | support | kept | none | 13 | 0 | no |  |
| test/fixtures/task-admission/review-worker.ts | support | src-unit | src | 14 | 2 | yes |  |
| test/fixtures/task-lock-holder.ts | support | src-unit | src | 22 | 2 | yes |  |
| test/fixtures/task-log-core.ts | support | src-unit | src | 22 | 3 | yes |  |
| test/fixtures/task-preparation-worker.ts | support | src-unit | src | 25 | 2 | yes |  |
| test/fixtures/terminal-browser.tsx | support | src-unit | src | 42 | 1 | yes |  |
| test/fixtures/terminal-search-browser.tsx | support | kept | none | 5 | 0 | yes |  |
| test/fixtures/terminal-style.ts | support | kept | none | 7 | 0 | no |  |
| test/fixtures/toolchain-home-probe.ts | support | kept | none | 11 | 0 | no |  |
| test/fixtures/trace-answer-browser.tsx | support | kept | none | 50 | 0 | yes |  |
| test/fixtures/trace-browser.tsx | support | src-unit | src | 43 | 1 | yes |  |
| test/fixtures/trace-preview-browser.tsx | support | kept | none | 19 | 0 | yes |  |
| test/fixtures/tray-board.ts | support | src-unit | src | 40 | 2 | yes |  |
| test/fixtures/ui/accounts-table.tsx | support | kept | none | 29 | 0 | yes |  |
| test/fixtures/ui/add-agent.tsx | support | kept | none | 25 | 0 | yes |  |
| test/fixtures/ui/add-host.tsx | support | kept | none | 42 | 0 | yes |  |
| test/fixtures/ui/all-pages-browser.tsx | support | kept | none | 75 | 0 | yes |  |
| test/fixtures/ui/app-states.tsx | support | src-unit | src | 70 | 1 | yes |  |
| test/fixtures/ui/choice-picker-browser.tsx | support | kept | none | 72 | 0 | yes |  |
| test/fixtures/ui/conversation-terminal.tsx | support | kept | none | 55 | 0 | yes |  |
| test/fixtures/ui/discovery-notice.tsx | support | src-unit | src | 29 | 1 | yes |  |
| test/fixtures/ui/discovery-switch.tsx | support | kept | none | 20 | 0 | yes |  |
| test/fixtures/ui/dispatch-age.tsx | support | src-unit | src | 12 | 1 | yes |  |
| test/fixtures/ui/executor-editor.tsx | support | kept | none | 44 | 0 | yes |  |
| test/fixtures/ui/file-viewer-browser.tsx | support | src-unit | src | 43 | 1 | yes |  |
| test/fixtures/ui/filter-refresh-browser.tsx | support | src-unit | src | 70 | 1 | yes |  |
| test/fixtures/ui/geometry.ts | support | kept | none | 4 | 0 | no |  |
| test/fixtures/ui/insights-browser.tsx | support | kept | none | 31 | 0 | yes |  |
| test/fixtures/ui/managed-tray.tsx | support | src-unit | src | 23 | 1 | yes |  |
| test/fixtures/ui/needs-you.tsx | support | src-unit | src | 49 | 1 | yes |  |
| test/fixtures/ui/notice-frame.tsx | support | kept | none | 29 | 0 | yes |  |
| test/fixtures/ui/notice-stack.tsx | support | src-unit | src | 33 | 1 | yes |  |
| test/fixtures/ui/overview-pagination.tsx | support | kept | none | 16 | 0 | no |  |
| test/fixtures/ui/page-scroll.ts | support | kept | none | 9 | 0 | no |  |
| test/fixtures/ui/planner-preview-keyboard.tsx | support | kept | none | 8 | 0 | yes |  |
| test/fixtures/ui/plugin-activity-browser.tsx | support | kept | none | 23 | 0 | yes |  |
| test/fixtures/ui/plugin-settings-browser.tsx | support | kept | none | 53 | 0 | yes |  |
| test/fixtures/ui/plugin-settings-data.ts | support | src-unit | src | 14 | 1 | yes |  |
| test/fixtures/ui/session-panel-board.tsx | support | src-unit | src | 16 | 2 | yes |  |
| test/fixtures/ui/sessions-list.tsx | support | src-unit | src | 13 | 1 | yes |  |
| test/fixtures/ui/settings-copy-browser.tsx | support | src-unit | src | 12 | 1 | yes |  |
| test/fixtures/ui/settings-plugins.tsx | support | kept | none | 41 | 0 | yes |  |
| test/fixtures/ui/settings.ts | support | src-unit | src | 7 | 2 | yes |  |
| test/fixtures/ui/setup-health-gate-browser.tsx | support | src-unit | src | 27 | 1 | yes |  |
| test/fixtures/ui/shell-panels-browser.tsx | support | kept | none | 112 | 0 | yes |  |
| test/fixtures/ui/shell-regions-browser.tsx | support | kept | none | 38 | 0 | yes |  |
| test/fixtures/ui/skeleton.tsx | support | kept | none | 12 | 0 | yes |  |
| test/fixtures/ui/sortable-browser.tsx | support | src-unit | src | 119 | 1 | yes |  |
| test/fixtures/ui/task-tree-browser.tsx | support | src-unit | src | 23 | 1 | yes |  |
| test/fixtures/ui/tasks-layout-browser.tsx | support | kept | none | 26 | 0 | yes |  |
| test/fixtures/ui/tasks-page-browser.tsx | support | src-unit | src | 31 | 1 | yes |  |
| test/fixtures/ui/update-notice-browser.tsx | support | src-unit | src | 30 | 1 | yes |  |
| test/fixtures/ui/work-focus-browser.tsx | support | kept | none | 13 | 0 | yes |  |
| test/fixtures/unavailable-filesystem.ts | support | kept | none | 3 | 0 | no |  |
| test/fixtures/unavailable-observations.ts | support | kept | none | 12 | 0 | no |  |
| test/fixtures/update-poll-browser.tsx | support | kept | none | 22 | 0 | yes |  |
| test/fixtures/upgrade/0.10.0/cli-hello.ts | support | kept | none | 3 | 0 | no |  |
| test/fixtures/upgrade/0.10.0/framing.ts | support | kept | none | 48 | 0 | no |  |
| test/fixtures/upgrade/0.10.0/term-client.ts | support | kept | none | 91 | 0 | no |  |
| test/fixtures/upgrade/0.10.0/viewers.ts | support | kept | none | 123 | 0 | no |  |
| test/fixtures/upgrade/0.11.0/cli-hello.ts | support | kept | none | 3 | 0 | no |  |
| test/fixtures/upgrade/0.11.0/framing.ts | support | kept | none | 48 | 0 | no |  |
| test/fixtures/upgrade/0.11.0/term-client.ts | support | kept | none | 91 | 0 | no |  |
| test/fixtures/upgrade/0.11.0/viewers.ts | support | kept | none | 123 | 0 | no |  |
| test/fixtures/upgrade/0.12.0/cli-hello.ts | support | kept | none | 3 | 0 | no |  |
| test/fixtures/upgrade/0.12.0/framing.ts | support | kept | none | 48 | 0 | no |  |
| test/fixtures/upgrade/0.12.0/term-client.ts | support | kept | none | 91 | 0 | no |  |
| test/fixtures/upgrade/0.12.0/viewers.ts | support | kept | none | 123 | 0 | no |  |
| test/fixtures/usage-refresh-browser.tsx | support | src-unit | src | 21 | 1 | yes |  |
| test/fixtures/work-lease-oracle.ts | support | src-unit | src | 28 | 4 | yes |  |
| test/fixtures/workspace-answer-browser.tsx | support | kept | none | 99 | 0 | yes |  |
| test/fixtures/workspace-browser.tsx | support | kept | none | 78 | 0 | yes |  |
| test/fixtures/worktree-numeric.ts | support | src-unit | src | 35 | 5 | yes |  |
| test/golden-surfaces.test.tsx | test | src-unit | src | 221 | 6 | yes | golden |
| test/guard.test.ts | test | src-unit | src | 299 | 9 | yes | guard.test.ts |
| test/helpers.ts | support | src-unit | src | 148 | 6 | yes |  |
| test/hook-account.test.ts | test | src-unit | src | 54 | 2 | yes | hook |
| test/hooks.test.ts | test | src-unit | src | 120 | 8 | yes | hooks.test.ts |
| test/host-account-native-parity.test.ts | test | parity | parity | 65 | 2 | yes | host |
| test/host-bridge-auth.test.ts | test | src-unit | src | 124 | 1 | yes | host |
| test/host-check-job.test.ts | test | src-unit | src | 70 | 3 | yes | host |
| test/host-clean.test.ts | test | src-unit | src | 89 | 3 | yes | host |
| test/host-detail.test.ts | test | src-unit | src | 87 | 8 | yes | host |
| test/host-effects-bridge.test.ts | test | src-unit | src | 360 | 9 | yes | host |
| test/host-probe.test.ts | test | src-unit | src | 50 | 7 | yes | host |
| test/host-read-parity.test.ts | test | parity | parity | 104 | 5 | yes | host |
| test/host-repos.test.ts | test | src-unit | src | 105 | 4 | yes | host |
| test/host-ssh-lib-parity.test.ts | test | parity | parity | 48 | 2 | yes | host |
| test/http-retirement.test.ts | test | src-unit | src | 17 | 1 | yes | http |
| test/http.test.ts | test | src-unit | src | 49 | 1 | yes | http.test.ts |
| test/identity-cross-process.test.ts | test | src-unit | src | 73 | 4 | yes | identity |
| test/identity-edges.test.ts | test | src-unit | src | 173 | 9 | yes | identity |
| test/identity-encoding.test.ts | test | src-unit | src | 37 | 2 | yes | identity |
| test/identity-failures.test.ts | test | src-unit | src | 131 | 7 | yes | identity |
| test/identity-key-store.test.ts | test | src-unit | src | 59 | 1 | yes | identity |
| test/identity-load.test.ts | test | src-unit | src | 54 | 5 | yes | identity |
| test/identity-lock.test.ts | test | src-unit | src | 90 | 3 | yes | identity |
| test/identity-nits.test.ts | test | src-unit | src | 82 | 5 | yes | identity |
| test/identity-per-home.test.ts | test | src-unit | src | 101 | 3 | yes | identity |
| test/identity-rotate.test.ts | test | src-unit | src | 40 | 4 | yes | identity |
| test/identity-sign.test.ts | test | src-unit | src | 48 | 3 | yes | identity |
| test/identity-stamping.test.ts | test | src-unit | src | 56 | 5 | yes | identity |
| test/identity-store.test.ts | test | src-unit | src | 48 | 2 | yes | identity |
| test/insights-summary.test.ts | test | src-unit | src | 107 | 6 | yes | insights |
| test/install-blocks.test.ts | test | src-unit | src | 102 | 2 | yes | install |
| test/install-claude.test.ts | test | src-unit | src | 205 | 1 | yes | install |
| test/install-codex.test.ts | test | plugin | plugin | 136 | 1 | yes | install |
| test/install-commands.test.ts | test | src-unit | src | 616 | 12 | yes | install |
| test/install-compat.test.ts | test | src-unit | src | 111 | 5 | yes | install |
| test/install-created-refresh.test.ts | test | src-unit | src | 56 | 5 | yes | install |
| test/install-cursor.test.ts | test | plugin | plugin | 119 | 3 | yes | install |
| test/install-doctor.test.ts | test | src-unit | src | 259 | 5 | yes | install |
| test/install-helpers.ts | support | src-unit | src | 27 | 1 | yes |  |
| test/install-hookjson.test.ts | test | src-unit | src | 203 | 1 | yes | install |
| test/install-init.test.ts | test | src-unit | src | 142 | 3 | yes | install |
| test/install-jsonc.test.ts | test | src-unit | src | 122 | 1 | yes | install |
| test/install-lock.test.ts | test | src-unit | src | 32 | 1 | yes | install |
| test/install-managed-content.test.ts | test | src-unit | src | 32 | 2 | yes | install |
| test/install-opencode.test.ts | test | src-unit | src | 113 | 2 | yes | install |
| test/install-owner.test.ts | test | src-unit | src | 134 | 1 | yes | install |
| test/install-ownership-handback.test.ts | test | src-unit | src | 205 | 5 | yes | install |
| test/install-parity.test.ts | test | parity | parity | 207 | 11 | yes | install |
| test/install-path-block.test.ts | test | src-unit | src | 29 | 1 | yes | install |
| test/install-planner-account.test.ts | test | src-unit | src | 109 | 6 | yes | install |
| test/install-planner-resume.test.ts | test | src-unit | src | 145 | 3 | yes | install |
| test/install-plugin-adapter.ts | support | plugin | plugin | 120 | 5 | yes |  |
| test/install-plugin-fixtures.ts | support | src-unit | src | 28 | 2 | yes |  |
| test/install-policy.test.ts | test | plugin | plugin | 93 | 1 | yes | install |
| test/install-reconcile.test.ts | test | src-unit | src | 269 | 7 | yes | install |
| test/install-recorded-cleanup.test.ts | test | src-unit | src | 24 | 3 | yes | install |
| test/install-recovery.test.ts | test | src-unit | src | 48 | 2 | yes | install |
| test/install-robustness.test.ts | test | src-unit | src | 126 | 1 | yes | install |
| test/install-signin-delegation.test.ts | test | binary-e2e | e2e | 247 | 0 | yes | install |
| test/install-skill.test.ts | test | plugin | plugin | 76 | 5 | yes | install |
| test/install-stale-mcp.test.ts | test | src-unit | src | 258 | 7 | yes | install |
| test/install-status-flags.test.ts | test | src-unit | src | 122 | 2 | yes | install |
| test/install-statusline.test.ts | test | src-unit | src | 78 | 1 | yes | install |
| test/install-txn.test.ts | test | src-unit | src | 134 | 3 | yes | install |
| test/install-undo-content.test.ts | test | src-unit | src | 151 | 6 | yes | install |
| test/install-uninstall-user-content.test.ts | test | src-unit | src | 44 | 5 | yes | install |
| test/integration-lifecycle.test.ts | test | src-unit | src | 43 | 5 | yes | integration |
| test/interactive-lifecycle.test.ts | test | src-unit | src | 136 | 12 | yes | interactive |
| test/isolated-port.ts | support | kept | none | 34 | 0 | no |  |
| test/issue-import.test.ts | test | src-unit | src | 270 | 8 | yes | issue |
| test/jobs.test.ts | test | src-unit | src | 115 | 6 | yes | jobs.test.ts |
| test/js-trim-parity.test.ts | test | parity | parity | 7 | 0 | no | js |
| test/keychain-guard.test.ts | test | kept | none | 27 | 0 | yes | keychain |
| test/keychain-stub.ts | support | kept | none | 14 | 0 | yes |  |
| test/launch-mode.test.ts | test | src-unit | src | 386 | 13 | yes | launch |
| test/launch.test.ts | test | src-unit | src | 183 | 2 | yes | launch.test.ts |
| test/limits-retry-banner.test.ts | test | src-unit | src | 64 | 3 | yes | limits |
| test/limits.test.ts | test | src-unit | src | 97 | 3 | yes | limits.test.ts |
| test/link-bridge.test.ts | test | src-unit | src | 10 | 1 | yes | link |
| test/link-consoles.test.ts | test | src-unit | src | 111 | 9 | yes | link |
| test/link-envelope.test.ts | test | src-unit | src | 92 | 1 | yes | link |
| test/link-publish.test.ts | test | src-unit | src | 82 | 5 | yes | link |
| test/link-pump-incremental.test.ts | test | src-unit | src | 531 | 26 | yes | link |
| test/link-pump-poll.test.ts | test | src-unit | src | 165 | 18 | yes | link |
| test/link-pump.test.ts | test | src-unit | src | 286 | 31 | yes | link |
| test/link-retired.test.ts | test | src-unit | src | 19 | 1 | yes | link |
| test/live-api-guard.test.ts | test | src-unit | src | 124 | 1 | yes | live |
| test/live-capture-content.test.ts | test | kept | none | 115 | 0 | yes | live |
| test/live-checkout.test.ts | test | src-unit | src | 23 | 1 | yes | live |
| test/live-checkout.ts | support | src-unit | src | 21 | 1 | yes |  |
| test/live-control-browser.test.ts | test | kept | none | 35 | 0 | yes | live |
| test/live-control-cli-routing.test.ts | test | kept | none | 26 | 0 | yes | live |
| test/live-control-contract.test.ts | test | kept | none | 88 | 0 | yes | live |
| test/live-control-desktop.test.ts | test | kept | none | 10 | 0 | yes | live |
| test/live-control-doctor.test.ts | test | kept | none | 68 | 0 | yes | live |
| test/live-control-evidence.test.ts | test | kept | none | 59 | 0 | yes | live |
| test/live-control-native-delivery.test.ts | test | kept | none | 52 | 0 | yes | live |
| test/live-control-native-observer.test.ts | test | kept | none | 32 | 0 | yes | live |
| test/live-control-ota-windows.test.ts | test | kept | none | 74 | 0 | yes | live |
| test/live-control-ownership.test.ts | test | kept | none | 43 | 0 | yes | live |
| test/live-control-permission-chip.test.ts | test | kept | none | 44 | 0 | yes | live |
| test/live-control-png.test.ts | test | src-unit | src | 11 | 1 | yes | live |
| test/live-control-scenarios.test.ts | test | kept | none | 16 | 0 | yes | live |
| test/live-control-tui.test.ts | test | kept | none | 28 | 0 | yes | live |
| test/live-core-repair.test.ts | test | kept | none | 40 | 0 | yes | live |
| test/live-harness.test.ts | test | src-unit | src | 1040 | 11 | yes | live |
| test/live-integrations.test.ts | test | kept | none | 31 | 0 | yes | live |
| test/live-keychain.test.ts | test | src-unit | src | 82 | 4 | yes | live |
| test/live-ota-adoption-outcome.test.ts | test | kept | none | 42 | 0 | yes | live |
| test/live-ota-baseline-request-stages.test.ts | test | src-unit | src | 147 | 1 | yes | live |
| test/live-ota-build.test.ts | test | kept | none | 204 | 0 | yes | live |
| test/live-ota-bundle-metadata.test.ts | test | kept | none | 47 | 0 | yes | live |
| test/live-ota-candidate.test.ts | test | kept | none | 30 | 0 | yes | live |
| test/live-ota-control-binding.test.ts | test | kept | none | 89 | 0 | yes | live |
| test/live-ota-control-deadline.test.ts | test | kept | none | 102 | 0 | yes | live |
| test/live-ota-control-resolver.test.ts | test | kept | none | 81 | 0 | yes | live |
| test/live-ota-diagnostics.test.ts | test | kept | none | 74 | 0 | yes | live |
| test/live-ota-evidence.test.ts | test | kept | none | 32 | 0 | yes | live |
| test/live-ota-exercise-record.test.ts | test | kept | none | 46 | 0 | no | live |
| test/live-ota-layout-cli.test.ts | test | kept | none | 27 | 0 | yes | live |
| test/live-ota-lock.test.ts | test | kept | none | 32 | 0 | yes | live |
| test/live-ota-native.test.ts | test | src-unit | src | 67 | 1 | yes | live |
| test/live-ota-outcome.test.ts | test | kept | none | 37 | 0 | yes | live |
| test/live-ota-paired-build.test.ts | test | kept | none | 66 | 0 | yes | live |
| test/live-ota-paired-proof.test.ts | test | kept | none | 50 | 0 | yes | live |
| test/live-ota-real-app.test.ts | test | kept | none | 65 | 0 | yes | live |
| test/live-ota-request-trace.test.ts | test | kept | none | 80 | 0 | yes | live |
| test/live-ota-request.test.ts | test | src-unit | src | 99 | 1 | yes | live |
| test/live-ota-takeover.test.ts | test | kept | none | 71 | 0 | yes | live |
| test/live-ota-trace-verdicts.test.ts | test | kept | none | 35 | 0 | yes | live |
| test/live-ota.test.ts | test | src-unit | src | 592 | 3 | yes | live |
| test/live-plugin-remove.test.ts | test | src-unit | src | 107 | 1 | yes | live |
| test/live-process-cleanup.test.ts | test | src-unit | src | 279 | 1 | yes | live |
| test/live-proxy-trace.test.ts | test | kept | none | 102 | 0 | yes | live |
| test/live-publication.test.ts | test | kept | none | 34 | 0 | yes | live |
| test/live-repair.test.ts | test | src-unit | src | 83 | 3 | yes | live |
| test/live-session-stream-fault.test.ts | test | kept | none | 83 | 0 | yes | live |
| test/live-settings.test.ts | test | kept | none | 63 | 0 | yes | live |
| test/live-terminal-guard.test.ts | test | kept | none | 31 | 0 | yes | live |
| test/live-updater.test.ts | test | kept | none | 60 | 0 | yes | live |
| test/live-upgrade.test.ts | test | src-unit | src | 134 | 3 | yes | live |
| test/login-env.test.ts | test | src-unit | src | 266 | 5 | yes | login |
| test/m1-gate.test.ts | test | src-unit | src | 78 | 1 | yes | m1 |
| test/m3-test-triage.test.ts | test | parity | parity | 26 | 0 | no | m3 |
| test/machine-cli.test.ts | test | src-unit | src | 54 | 4 | yes | machine |
| test/managed-status-browser.test.ts | test | kept | none | 52 | 0 | no | managed |
| test/mcp-assistant.test.ts | test | src-unit | src | 160 | 9 | yes | mcp |
| test/mcp-parity.test.ts | test | parity | parity | 639 | 5 | yes | mcp |
| test/mcp.test.ts | test | src-unit | src | 348 | 6 | yes | mcp.test.ts |
| test/messaging-attention.test.ts | test | src-unit | src | 83 | 6 | yes | messaging |
| test/messaging-broker.test.ts | test | src-unit | src | 583 | 14 | yes | messaging |
| test/messaging-caller-reach.test.ts | test | src-unit | src | 122 | 8 | yes | messaging |
| test/messaging-cli.test.ts | test | src-unit | src | 105 | 5 | yes | messaging |
| test/messaging-followups.test.ts | test | src-unit | src | 118 | 5 | yes | messaging |
| test/messaging-hooks.test.ts | test | src-unit | src | 196 | 9 | yes | messaging |
| test/messaging-identity.test.ts | test | binary-e2e | e2e | 79 | 4 | yes | messaging |
| test/messaging-lifecycle.test.ts | test | src-unit | src | 258 | 8 | yes | messaging |
| test/messaging-live.test.ts | test | src-unit | src | 609 | 15 | yes | messaging |
| test/messaging-liveness.test.ts | test | src-unit | src | 232 | 6 | yes | messaging |
| test/messaging-ops.test.ts | test | src-unit | src | 99 | 3 | yes | messaging |
| test/messaging-participants.test.ts | test | src-unit | src | 81 | 3 | yes | messaging |
| test/messaging-policy-turns.test.ts | test | src-unit | src | 305 | 13 | yes | messaging |
| test/messaging-policy.test.ts | test | src-unit | src | 82 | 4 | yes | messaging |
| test/messaging-project-policy.test.ts | test | src-unit | src | 64 | 4 | yes | messaging |
| test/messaging-regressions.test.ts | test | src-unit | src | 260 | 12 | yes | messaging |
| test/messaging-resume.test.ts | test | src-unit | src | 92 | 6 | yes | messaging |
| test/messaging-store.test.ts | test | src-unit | src | 61 | 1 | yes | messaging |
| test/messaging-turns.test.ts | test | src-unit | src | 87 | 6 | yes | messaging |
| test/messaging-user-grants.test.ts | test | src-unit | src | 148 | 14 | yes | messaging |
| test/messaging-user-retry.test.ts | test | src-unit | src | 77 | 6 | yes | messaging |
| test/messaging-user-strict.test.ts | test | src-unit | src | 141 | 13 | yes | messaging |
| test/messaging-work-turns.test.ts | test | src-unit | src | 172 | 15 | yes | messaging |
| test/mode-hold.test.ts | test | src-unit | src | 34 | 6 | yes | mode |
| test/models-available.test.ts | test | src-unit | src | 133 | 2 | yes | models |
| test/native-account-list-parity.test.ts | test | parity | parity | 398 | 3 | yes | native |
| test/native-account-parity.test.ts | test | parity | parity | 197 | 1 | yes | native |
| test/native-agent-e2e.test.ts | test | parity | parity | 325 | 0 | no | native |
| test/native-agent-limits-parity.test.ts | test | parity | parity | 130 | 6 | yes | native |
| test/native-agent-parity.test.ts | test | parity | parity | 117 | 3 | yes | native |
| test/native-analytics-parity.test.ts | test | parity | parity | 197 | 5 | yes | native |
| test/native-assistant-parity.test.ts | test | parity | parity | 181 | 3 | yes | native |
| test/native-assistant-turn-parity.test.ts | test | parity | parity | 254 | 5 | yes | native |
| test/native-bundled.test.ts | test | src-unit | src | 58 | 1 | yes | native |
| test/native-client-ops-parity.test.ts | test | parity | parity | 447 | 2 | yes | native |
| test/native-config-ops.test.ts | test | src-unit | src | 395 | 3 | yes | native |
| test/native-config-set-parity.test.ts | test | parity | parity | 156 | 0 | yes | native |
| test/native-desktop-capture-update-parity.test.ts | test | parity | parity | 240 | 6 | yes | native |
| test/native-discovery-desktop-parity.test.ts | test | parity | parity | 156 | 2 | yes | native |
| test/native-dispatch-dependencies-parity.test.ts | test | parity | parity | 177 | 4 | yes | native |
| test/native-dispatch-enforcement-parity.test.ts | test | parity | parity | 178 | 0 | yes | native |
| test/native-dispatch-lifecycle-effects.test.ts | test | parity | parity | 105 | 3 | yes | native |
| test/native-dispatch-lifecycle-parity.test.ts | test | parity | parity | 177 | 0 | yes | native |
| test/native-dispatch-planning-parity.test.ts | test | parity | parity | 186 | 2 | yes | native |
| test/native-dispatch-preview-parity.test.ts | test | parity | parity | 588 | 7 | yes | native |
| test/native-dispatch-reads-parity.test.ts | test | parity | parity | 290 | 4 | yes | native |
| test/native-dispatch.test.ts | test | parity | parity | 234 | 0 | no | native |
| test/native-executor-models-available-parity.test.ts | test | parity | parity | 260 | 0 | no | native |
| test/native-helper-request-timing.test.ts | test | src-unit | src | 27 | 1 | yes | native |
| test/native-host-check-clean-parity.test.ts | test | parity | parity | 527 | 2 | yes | native |
| test/native-host-set-parity.test.ts | test | parity | parity | 70 | 0 | no | native |
| test/native-host-setup-parity.test.ts | test | parity | parity | 481 | 2 | yes | native |
| test/native-install-apply-e2e.test.ts | test | parity | parity | 704 | 2 | yes | native |
| test/native-install-apply-parity.test.ts | test | parity | parity | 199 | 5 | yes | native |
| test/native-issue-parity.test.ts | test | parity | parity | 157 | 4 | yes | native |
| test/native-job-strategy-setup-parity.test.ts | test | parity | parity | 263 | 1 | yes | native |
| test/native-listener-handoff.test.ts | test | kept | none | 104 | 0 | yes | native |
| test/native-machine-parity.test.ts | test | parity | parity | 175 | 5 | yes | native |
| test/native-managed-attention-parity.test.ts | test | parity | parity | 57 | 4 | yes | native |
| test/native-meta-ops-parity.test.ts | test | parity | parity | 93 | 1 | yes | native |
| test/native-msg-live-answer-parity.test.ts | test | parity | parity | 128 | 7 | yes | native |
| test/native-msg-policy-parity.test.ts | test | parity | parity | 158 | 5 | yes | native |
| test/native-msg-reads-parity.test.ts | test | parity | parity | 221 | 5 | yes | native |
| test/native-msg-writes-parity.test.ts | test | parity | parity | 256 | 5 | yes | native |
| test/native-p8-ops-parity.test.ts | test | parity | parity | 58 | 5 | yes | native |
| test/native-plugin-crash.test.ts | test | parity | parity | 388 | 3 | yes | native |
| test/native-plugin-door.ts | support | parity | parity | 186 | 0 | no |  |
| test/native-plugin-ops-homes.test.ts | test | parity | parity | 67 | 0 | yes | native |
| test/native-plugin-ops-service.ts | support | parity | parity | 68 | 0 | yes |  |
| test/native-plugin-ops-stdio.test.ts | test | parity | parity | 655 | 3 | yes | native |
| test/native-plugin-ops.test.ts | test | parity | parity | 482 | 0 | yes | native |
| test/native-project-messaging-parity.test.ts | test | parity | parity | 107 | 2 | yes | native |
| test/native-project-strategy-parity.test.ts | test | parity | parity | 406 | 0 | no | native |
| test/native-repo-add-parity.test.ts | test | parity | parity | 138 | 2 | yes | native |
| test/native-repo-front-door.ts | support | parity | parity | 249 | 0 | yes |  |
| test/native-repo-registry-parity.test.ts | test | parity | parity | 272 | 3 | yes | native |
| test/native-repo-remove-parity.test.ts | test | parity | parity | 313 | 0 | yes | native |
| test/native-retry-options-parity.test.ts | test | parity | parity | 254 | 5 | yes | native |
| test/native-routing-residue-parity.test.ts | test | parity | parity | 361 | 5 | yes | native |
| test/native-runner-check-forwarding.test.ts | test | parity | parity | 132 | 3 | yes | native |
| test/native-runner-check-parity.test.ts | test | parity | parity | 64 | 2 | yes | native |
| test/native-runner-check-stdio.test.ts | test | parity | parity | 83 | 0 | no | native |
| test/native-runner-discovery-attention-parity.test.ts | test | parity | parity | 179 | 8 | yes | native |
| test/native-runner-models-ops-parity.test.ts | test | parity | parity | 463 | 0 | no | native |
| test/native-runner-models-parity.test.ts | test | parity | parity | 219 | 0 | no | native |
| test/native-service-update-parity.test.ts | test | parity | parity | 201 | 3 | yes | native |
| test/native-session-context-parity.test.ts | test | parity | parity | 117 | 3 | yes | native |
| test/native-session-lifecycle-parity.test.ts | test | parity | parity | 232 | 1 | yes | native |
| test/native-setup-doctor-parity.test.ts | test | parity | parity | 234 | 5 | yes | native |
| test/native-setup-gate-parity.test.ts | test | parity | parity | 217 | 7 | yes | native |
| test/native-setup-parity.test.ts | test | parity | parity | 389 | 2 | yes | native |
| test/native-snapshot-get-parity.test.ts | test | parity | parity | 145 | 3 | yes | native |
| test/native-stdio-request-id-parity.test.ts | test | parity | parity | 68 | 0 | yes | native |
| test/native-task-delegation-parity.test.ts | test | parity | parity | 243 | 5 | yes | native |
| test/native-task-get-parity.test.ts | test | parity | parity | 106 | 3 | yes | native |
| test/native-task-list-parity.test.ts | test | parity | parity | 116 | 2 | yes | native |
| test/native-task-reads-parity.test.ts | test | parity | parity | 277 | 1 | yes | native |
| test/native-task-review-parity.test.ts | test | parity | parity | 170 | 3 | yes | native |
| test/native-task-send-parity.test.ts | test | parity | parity | 285 | 8 | yes | native |
| test/native-task-stop-parity.test.ts | test | parity | parity | 76 | 3 | yes | native |
| test/native-task-wait-parity.test.ts | test | parity | parity | 83 | 3 | yes | native |
| test/native-terminal-parity.test.ts | test | parity | parity | 319 | 3 | yes | native |
| test/needs-you-old-questions.test.ts | test | src-unit | src | 67 | 4 | yes | needs |
| test/notification-health.test.ts | test | src-unit | src | 194 | 6 | yes | notification |
| test/notify-decide.test.ts | test | src-unit | src | 280 | 12 | yes | notify |
| test/notify-level.test.ts | test | src-unit | src | 12 | 3 | yes | notify |
| test/onboarding-try.test.ts | test | src-unit | src | 121 | 15 | yes | onboarding |
| test/onboarding-wave1.test.ts | test | src-unit | src | 110 | 11 | yes | onboarding |
| test/op-catalog-parity.test.ts | test | parity | parity | 12 | 1 | yes | op |
| test/opencode-spend-status.test.ts | test | src-unit | src | 134 | 9 | yes | opencode |
| test/orca-backend.test.ts | test | src-unit | src | 1817 | 44 | yes | orca |
| test/orca-caller-ping.test.ts | test | src-unit | src | 122 | 1 | yes | orca |
| test/orca-cleanup.test.ts | test | src-unit | src | 88 | 4 | yes | orca |
| test/orca-client.test.ts | test | src-unit | src | 147 | 1 | yes | orca |
| test/orca-execution-config.test.ts | test | src-unit | src | 106 | 2 | yes | orca |
| test/orca-setup.test.ts | test | src-unit | src | 203 | 5 | yes | orca |
| test/orca-state.test.ts | test | src-unit | src | 97 | 1 | yes | orca |
| test/orca-status.test.ts | test | src-unit | src | 113 | 4 | yes | orca |
| test/orca-wait.test.ts | test | src-unit | src | 208 | 5 | yes | orca |
| test/owner-guard-commands.test.ts | test | src-unit | src | 50 | 3 | yes | owner |
| test/p6e-parity.test.ts | test | parity | parity | 67 | 0 | yes | p6e |
| test/parity-harness.test.ts | test | parity | parity | 154 | 1 | yes | parity |
| test/parity-harness.ts | support | parity | parity | 220 | 0 | no |  |
| test/path-probe-waiting.test.ts | test | src-unit | src | 34 | 1 | yes | path |
| test/path-probe.test.ts | test | src-unit | src | 142 | 9 | yes | path |
| test/pause.test.ts | test | src-unit | src | 52 | 9 | yes | pause.test.ts |
| test/perf-core-responsiveness.test.ts | test | src-unit | src | 124 | 3 | yes | perf |
| test/perf-pump-tick.test.ts | test | kept | none | 10 | 0 | no | perf |
| test/pinned-port.test.ts | test | src-unit | src | 40 | 1 | yes | pinned |
| test/pinned-port.ts | support | kept | none | 38 | 0 | no |  |
| test/placement.test.ts | test | src-unit | src | 42 | 6 | yes | placement.test.ts |
| test/planner-command-fixtures.ts | support | src-unit | src | 50 | 2 | yes |  |
| test/planner-detect-fixtures.ts | support | src-unit | src | 65 | 2 | yes |  |
| test/planner-undo.test.ts | test | src-unit | src | 340 | 6 | yes | planner |
| test/plugin-conformance-native-owner-deadlines.test.ts | test | kept | none | 106 | 0 | yes | plugin |
| test/plugin-conformance-native-owner-relay.test.ts | test | parity | parity | 154 | 0 | yes | plugin |
| test/plugin-conformance-native-owner-support.ts | support | parity | parity | 87 | 0 | yes |  |
| test/plugin-conformance-native-owner.test.ts | test | kept | none | 78 | 0 | yes | plugin |
| test/plugin-conformance-overlap.test.ts | test | kept | none | 68 | 0 | yes | plugin |
| test/plugin-conformance.test.ts | test | kept | none | 36 | 0 | yes | plugin |
| test/plugin-fixtures.test.ts | test | kept | none | 35 | 0 | no | plugin |
| test/plugin-host-structure.test.ts | test | kept | none | 19 | 0 | no | plugin |
| test/plugin-owning-call-methods.test.ts | test | src-unit | src | 24 | 2 | yes | plugin |
| test/plugin-protocol-doc.test.ts | test | src-unit | src | 50 | 1 | yes | plugin |
| test/plugin-retired.test.ts | test | src-unit | src | 59 | 3 | yes | plugin |
| test/plugin-sdk-error-reason.test.ts | test | kept | none | 88 | 0 | no | plugin |
| test/plugin-sdk-events.test.ts | test | kept | none | 53 | 0 | no | plugin |
| test/plugin-sdk-fs.test.ts | test | kept | none | 132 | 0 | no | plugin |
| test/plugin-sdk-install-blocks.test.ts | test | kept | none | 89 | 0 | no | plugin |
| test/plugin-sdk-install-entry.test.ts | test | kept | none | 8 | 0 | no | plugin |
| test/plugin-sdk-install-helpers.test.ts | test | src-unit | src | 21 | 1 | yes | plugin |
| test/plugin-sdk-install-hookjson.test.ts | test | kept | none | 200 | 0 | no | plugin |
| test/plugin-sdk-install-journal.test.ts | test | src-unit | src | 112 | 2 | yes | plugin |
| test/plugin-sdk-install-jsonc.test.ts | test | kept | none | 122 | 0 | no | plugin |
| test/plugin-sdk-install-managed-content.test.ts | test | src-unit | src | 28 | 1 | yes | plugin |
| test/plugin-sdk-install-plan.test.ts | test | src-unit | src | 117 | 1 | yes | plugin |
| test/plugin-sdk-install-prepared.test.ts | test | kept | none | 186 | 0 | no | plugin |
| test/plugin-sdk-install-txn.test.ts | test | kept | none | 166 | 0 | no | plugin |
| test/plugin-sdk-install-undo.test.ts | test | src-unit | src | 77 | 1 | yes | plugin |
| test/plugin-sdk-session-stream.test.ts | test | kept | none | 81 | 0 | no | plugin |
| test/plugin-sdk.test.ts | test | kept | none | 79 | 0 | no | plugin |
| test/plugins-archive.test.ts | test | src-unit | src | 301 | 3 | yes | plugins |
| test/plugins-bundle-stage.test.ts | test | src-unit | src | 404 | 4 | yes | plugins |
| test/plugins-bundled-launch.test.ts | test | binary-e2e | e2e | 64 | 4 | yes | plugins |
| test/plugins-canonical-endpoint.test.ts | test | src-unit | src | 23 | 3 | yes | plugins |
| test/plugins-capability-duplex.test.ts | test | src-unit | src | 272 | 4 | yes | plugins |
| test/plugins-capability-write.test.ts | test | src-unit | src | 424 | 5 | yes | plugins |
| test/plugins-claimed-bundle.test.ts | test | src-unit | src | 360 | 7 | yes | plugins |
| test/plugins-classifier-config.test.ts | test | src-unit | src | 42 | 6 | yes | plugins |
| test/plugins-classifier-generation.test.ts | test | src-unit | src | 196 | 3 | yes | plugins |
| test/plugins-classifier-http-protocol.test.ts | test | src-unit | src | 72 | 2 | yes | plugins |
| test/plugins-classifier-proxy.test.ts | test | src-unit | src | 54 | 4 | yes | plugins |
| test/plugins-classify-adapters.test.ts | test | kept | none | 72 | 0 | no | plugins |
| test/plugins-classify-handler.test.ts | test | plugin | plugin | 23 | 0 | no | plugins |
| test/plugins-cli.test.ts | test | src-unit | src | 58 | 3 | yes | plugins |
| test/plugins-config.test.ts | test | src-unit | src | 41 | 2 | yes | plugins |
| test/plugins-credential-bindings.test.ts | test | src-unit | src | 100 | 2 | yes | plugins |
| test/plugins-credential-registry.test.ts | test | src-unit | src | 26 | 4 | yes | plugins |
| test/plugins-duplex-read.test.ts | test | src-unit | src | 28 | 1 | yes | plugins |
| test/plugins-endpoint-adapter.test.ts | test | src-unit | src | 37 | 4 | yes | plugins |
| test/plugins-endpoint-authority.test.ts | test | src-unit | src | 12 | 1 | yes | plugins |
| test/plugins-endpoint-config.test.ts | test | plugin | plugin | 60 | 0 | no | plugins |
| test/plugins-endpoint-launch-env.test.ts | test | plugin | plugin | 20 | 0 | no | plugins |
| test/plugins-endpoint-models.test.ts | test | plugin | plugin | 82 | 0 | no | plugins |
| test/plugins-endpoint-protocol.test.ts | test | src-unit | src | 40 | 4 | yes | plugins |
| test/plugins-endpoint-test-registry.test.ts | test | src-unit | src | 23 | 3 | yes | plugins |
| test/plugins-endpoint-test-task.test.ts | test | plugin | plugin | 7 | 0 | no | plugins |
| test/plugins-error-reason.test.ts | test | src-unit | src | 39 | 4 | yes | plugins |
| test/plugins-errors.test.ts | test | src-unit | src | 25 | 2 | yes | plugins |
| test/plugins-events.test.ts | test | src-unit | src | 51 | 5 | yes | plugins |
| test/plugins-executor-attempt.test.ts | test | src-unit | src | 203 | 4 | yes | plugins |
| test/plugins-executor-available-protocol.test.ts | test | src-unit | src | 78 | 2 | yes | plugins |
| test/plugins-executor-bundled-route.test.ts | test | src-unit | src | 29 | 2 | yes | plugins |
| test/plugins-executor-detached-launch.test.ts | test | plugin | plugin | 328 | 11 | yes | plugins |
| test/plugins-executor-effect.test.ts | test | plugin | plugin | 186 | 5 | yes | plugins |
| test/plugins-executor-orca-protocol.test.ts | test | plugin | plugin | 98 | 3 | yes | plugins |
| test/plugins-executor-owned-provider.test.ts | test | plugin | plugin | 210 | 1 | yes | plugins |
| test/plugins-executor-production-contract.test.ts | test | src-unit | src | 24 | 2 | yes | plugins |
| test/plugins-executor-production-current.test.ts | test | plugin | plugin | 1334 | 16 | yes | plugins |
| test/plugins-executor-production-parity.test.ts | test | parity | parity | 388 | 16 | yes | plugins |
| test/plugins-executor-production-stop.test.ts | test | src-unit | src | 249 | 7 | yes | plugins |
| test/plugins-executor-progress.test.ts | test | src-unit | src | 54 | 3 | yes | plugins |
| test/plugins-executor-run-claim.test.ts | test | src-unit | src | 375 | 7 | yes | plugins |
| test/plugins-executor-run-contract.test.ts | test | src-unit | src | 162 | 7 | yes | plugins |
| test/plugins-executor-run-monitor.test.ts | test | src-unit | src | 255 | 11 | yes | plugins |
| test/plugins-executor-run-state.test.ts | test | src-unit | src | 79 | 4 | yes | plugins |
| test/plugins-executor-session-state.test.ts | test | plugin | plugin | 112 | 7 | yes | plugins |
| test/plugins-executor-worktree-protocol.test.ts | test | src-unit | src | 294 | 7 | yes | plugins |
| test/plugins-fetch-issuance.test.ts | test | src-unit | src | 168 | 6 | yes | plugins |
| test/plugins-file-write-transfers.test.ts | test | src-unit | src | 73 | 2 | yes | plugins |
| test/plugins-host-clean-issuer.test.ts | test | src-unit | src | 49 | 2 | yes | plugins |
| test/plugins-host-clone-bridge.test.ts | test | src-unit | src | 76 | 6 | yes | plugins |
| test/plugins-host-clone-issuer.test.ts | test | src-unit | src | 45 | 3 | yes | plugins |
| test/plugins-host-drift.test.ts | test | src-unit | src | 21 | 1 | yes | plugins |
| test/plugins-host-identity-issuer.test.ts | test | src-unit | src | 37 | 1 | yes | plugins |
| test/plugins-host-lease-fetch.test.ts | test | src-unit | src | 233 | 5 | yes | plugins |
| test/plugins-host-lease.test.ts | test | src-unit | src | 331 | 3 | yes | plugins |
| test/plugins-host-runner-protocol.test.ts | test | src-unit | src | 132 | 4 | yes | plugins |
| test/plugins-host-session-stream-bridge.test.ts | test | src-unit | src | 151 | 5 | yes | plugins |
| test/plugins-host-session-stream-issuer.test.ts | test | src-unit | src | 49 | 2 | yes | plugins |
| test/plugins-host-stop-bridge.test.ts | test | src-unit | src | 67 | 4 | yes | plugins |
| test/plugins-host-stop-issuer.test.ts | test | src-unit | src | 38 | 2 | yes | plugins |
| test/plugins-hosts-fetch-bridge.test.ts | test | src-unit | src | 243 | 7 | yes | plugins |
| test/plugins-hosts-identity-bridge.test.ts | test | src-unit | src | 67 | 4 | yes | plugins |
| test/plugins-hosts-protocol.test.ts | test | src-unit | src | 79 | 2 | yes | plugins |
| test/plugins-hosts-registry.test.ts | test | src-unit | src | 59 | 3 | yes | plugins |
| test/plugins-http-authority.test.ts | test | src-unit | src | 29 | 2 | yes | plugins |
| test/plugins-http-body-transfers.test.ts | test | src-unit | src | 86 | 2 | yes | plugins |
| test/plugins-http-broker.test.ts | test | src-unit | src | 55 | 5 | yes | plugins |
| test/plugins-http-executor.test.ts | test | kept | none | 33 | 0 | no | plugins |
| test/plugins-http-registry-integration.test.ts | test | src-unit | src | 22 | 2 | yes | plugins |
| test/plugins-identity-sign.test.ts | test | src-unit | src | 100 | 6 | yes | plugins |
| test/plugins-long-deadline.test.ts | test | src-unit | src | 15 | 3 | yes | plugins |
| test/plugins-manifest-parity.test.ts | test | parity | parity | 14 | 1 | yes | plugins |
| test/plugins-native-owner-assistant-key.test.ts | test | parity | parity | 151 | 0 | yes | plugins |
| test/plugins-native-owner-call.test.ts | test | src-unit | src | 1117 | 15 | yes | plugins |
| test/plugins-native-owner-detached-grants.test.ts | test | plugin | plugin | 175 | 7 | yes | plugins |
| test/plugins-native-owner-detached-stop.test.ts | test | parity | parity | 136 | 3 | yes | plugins |
| test/plugins-native-owner-hello-deadline.test.ts | test | parity | parity | 127 | 4 | yes | plugins |
| test/plugins-native-owner-matrix-reconcile.test.ts | test | parity | parity | 88 | 0 | yes | plugins |
| test/plugins-native-owner-matrix-runners.test.ts | test | parity | parity | 157 | 3 | yes | plugins |
| test/plugins-native-owner-matrix-stdio.test.ts | test | parity | parity | 65 | 0 | yes | plugins |
| test/plugins-native-owner-matrix-support.ts | support | parity | parity | 423 | 0 | yes |  |
| test/plugins-native-owner-matrix.test.ts | test | parity | parity | 42 | 0 | yes | plugins |
| test/plugins-notifier-adapter.test.ts | test | plugin | plugin | 92 | 0 | no | plugins |
| test/plugins-notifier-authority.test.ts | test | plugin | plugin | 152 | 5 | yes | plugins |
| test/plugins-notifier-protocol.test.ts | test | src-unit | src | 34 | 2 | yes | plugins |
| test/plugins-notifier-registry.test.ts | test | src-unit | src | 30 | 2 | yes | plugins |
| test/plugins-notifier-resources.test.ts | test | plugin | plugin | 34 | 1 | yes | plugins |
| test/plugins-observations-child.test.ts | test | src-unit | src | 46 | 6 | yes | plugins |
| test/plugins-observations-installed.test.ts | test | src-unit | src | 33 | 2 | yes | plugins |
| test/plugins-observations-native-kinds.test.ts | test | parity | parity | 124 | 7 | yes | plugins |
| test/plugins-observations-native-owner.test.ts | test | parity | parity | 186 | 6 | yes | plugins |
| test/plugins-observations-negative.test.ts | test | src-unit | src | 78 | 4 | yes | plugins |
| test/plugins-ops.test.ts | test | src-unit | src | 51 | 3 | yes | plugins |
| test/plugins-owner-deadline.test.ts | test | src-unit | src | 47 | 4 | yes | plugins |
| test/plugins-pairing.test.ts | test | src-unit | src | 113 | 10 | yes | plugins |
| test/plugins-planner-batch-regressions.test.ts | test | src-unit | src | 411 | 17 | yes | plugins |
| test/plugins-planner-cutover.test.ts | test | src-unit | src | 131 | 5 | yes | plugins |
| test/plugins-planner-install.test.ts | test | src-unit | src | 451 | 4 | yes | plugins |
| test/plugins-planner-lifetime.test.ts | test | src-unit | src | 183 | 3 | yes | plugins |
| test/plugins-planner-mode.test.ts | test | src-unit | src | 96 | 2 | yes | plugins |
| test/plugins-planner-paths.test.ts | test | src-unit | src | 222 | 5 | yes | plugins |
| test/plugins-planner-prior.test.ts | test | src-unit | src | 54 | 2 | yes | plugins |
| test/plugins-planner-protocol.test.ts | test | src-unit | src | 57 | 1 | yes | plugins |
| test/plugins-planner-read.test.ts | test | kept | none | 70 | 0 | no | plugins |
| test/plugins-planner-recovery.test.ts | test | src-unit | src | 107 | 3 | yes | plugins |
| test/plugins-planner-resources.test.ts | test | src-unit | src | 326 | 3 | yes | plugins |
| test/plugins-planner-retention.test.ts | test | src-unit | src | 141 | 5 | yes | plugins |
| test/plugins-planner-transport.test.ts | test | src-unit | src | 174 | 3 | yes | plugins |
| test/plugins-planner-write.test.ts | test | src-unit | src | 77 | 2 | yes | plugins |
| test/plugins-policy-admission-races.test.ts | test | src-unit | src | 72 | 6 | yes | plugins |
| test/plugins-policy-budget-example.test.ts | test | plugin | plugin | 118 | 5 | yes | plugins |
| test/plugins-policy-child-gates.test.ts | test | src-unit | src | 56 | 7 | yes | plugins |
| test/plugins-policy-contracts.test.ts | test | src-unit | src | 326 | 8 | yes | plugins |
| test/plugins-policy-displays.test.tsx | test | src-unit | src | 164 | 9 | yes | plugins |
| test/plugins-policy-evaluator.test.ts | test | src-unit | src | 179 | 2 | yes | plugins |
| test/plugins-policy-gates.test.ts | test | src-unit | src | 78 | 5 | yes | plugins |
| test/plugins-policy-http-cancel.test.ts | test | src-unit | src | 110 | 9 | yes | plugins |
| test/plugins-policy-kind.test.ts | test | src-unit | src | 13 | 1 | yes | plugins |
| test/plugins-policy-review-api.test.ts | test | src-unit | src | 29 | 6 | yes | plugins |
| test/plugins-policy-review-conflict.test.ts | test | src-unit | src | 24 | 3 | yes | plugins |
| test/plugins-policy-review-gates.test.ts | test | src-unit | src | 83 | 6 | yes | plugins |
| test/plugins-policy-route-gates.test.ts | test | src-unit | src | 215 | 12 | yes | plugins |
| test/plugins-policy-session-gates.test.ts | test | src-unit | src | 79 | 4 | yes | plugins |
| test/plugins-policy-work-gates.test.ts | test | src-unit | src | 87 | 5 | yes | plugins |
| test/plugins-policy.test.ts | test | src-unit | src | 257 | 3 | yes | plugins |
| test/plugins-process-transport.test.ts | test | src-unit | src | 23 | 2 | yes | plugins |
| test/plugins-process.test.ts | test | src-unit | src | 56 | 3 | yes | plugins |
| test/plugins-protocol.test.ts | test | src-unit | src | 52 | 2 | yes | plugins |
| test/plugins-publishers.test.ts | test | src-unit | src | 116 | 2 | yes | plugins |
| test/plugins-registry.test.ts | test | src-unit | src | 163 | 6 | yes | plugins |
| test/plugins-remote-preflight.test.ts | test | src-unit | src | 102 | 5 | yes | plugins |
| test/plugins-remote-prepare-recover.test.ts | test | plugin | plugin | 505 | 16 | yes | plugins |
| test/plugins-sdk-http.test.ts | test | kept | none | 64 | 0 | no | plugins |
| test/plugins-session-stream-transport.test.ts | test | src-unit | src | 149 | 4 | yes | plugins |
| test/plugins-spawn-context.test.ts | test | src-unit | src | 187 | 4 | yes | plugins |
| test/plugins-ssh-prepare-recover.test.ts | test | plugin | plugin | 113 | 1 | yes | plugins |
| test/plugins-ssh-provider.test.ts | test | plugin | plugin | 599 | 8 | yes | plugins |
| test/plugins-ssh-session-stream.test.ts | test | plugin | plugin | 104 | 0 | no | plugins |
| test/plugins-tasks-read.test.ts | test | src-unit | src | 60 | 6 | yes | plugins |
| test/plugins-ui-ops.test.ts | test | src-unit | src | 146 | 6 | yes | plugins |
| test/plugins-ui-schema.test.ts | test | src-unit | src | 95 | 2 | yes | plugins |
| test/plugins-usage-protocol.test.ts | test | src-unit | src | 71 | 2 | yes | plugins |
| test/plugins-usage-readers.test.ts | test | plugin | plugin | 191 | 7 | yes | plugins |
| test/plugins-write-authority.test.ts | test | src-unit | src | 14 | 1 | yes | plugins |
| test/plugins-write-protocol.test.ts | test | src-unit | src | 25 | 1 | yes | plugins |
| test/plugins-write-registry.test.ts | test | src-unit | src | 31 | 3 | yes | plugins |
| test/plugins-write-wire.test.ts | test | src-unit | src | 58 | 6 | yes | plugins |
| test/policy-fixture-cleanup.test.ts | test | kept | none | 28 | 0 | yes | policy |
| test/policy-route-checkpoint.test.ts | test | src-unit | src | 30 | 2 | yes | policy |
| test/policy-words.test.ts | test | src-unit | src | 15 | 1 | yes | policy |
| test/port-isolation.ts | support | src-unit | src | 26 | 1 | yes |  |
| test/prepared-admission-parity.test.ts | test | parity | parity | 81 | 0 | no | prepared |
| test/process-signal.test.ts | test | src-unit | src | 37 | 1 | yes | process |
| test/process.test.ts | test | src-unit | src | 129 | 1 | yes | process.test.ts |
| test/project-ranking.test.ts | test | src-unit | src | 51 | 3 | yes | project |
| test/project-routing-identity.test.ts | test | src-unit | src | 29 | 2 | yes | project |
| test/project-strategies.test.ts | test | src-unit | src | 43 | 1 | yes | project |
| test/project-strategy-cli.test.ts | test | src-unit | src | 74 | 3 | yes | project |
| test/project-task-policy.test.ts | test | src-unit | src | 174 | 10 | yes | project |
| test/prompt.test.ts | test | src-unit | src | 71 | 1 | yes | prompt.test.ts |
| test/protocol-schema.test.ts | test | src-unit | src | 32 | 1 | yes | protocol |
| test/queue-helpers.ts | support | src-unit | src | 14 | 4 | yes |  |
| test/rank.test.ts | test | src-unit | src | 196 | 3 | yes | rank.test.ts |
| test/read-model-helpers.ts | support | src-unit | src | 13 | 3 | yes |  |
| test/read-model-orchestrate-capacity.test.ts | test | src-unit | src | 117 | 6 | yes | read |
| test/read-model-parity.test.ts | test | parity | parity | 518 | 19 | yes | read |
| test/read-model-rust-helpers.ts | support | src-unit | src | 131 | 9 | yes |  |
| test/read-model-rust-parity.test.ts | test | parity | parity | 156 | 19 | yes | read |
| test/read-model-tier.test.ts | test | src-unit | src | 15 | 3 | yes | read |
| test/read-model-visible-task.test.ts | test | parity | parity | 92 | 3 | yes | read |
| test/real-install-guard.test.ts | test | kept | none | 189 | 0 | yes | real |
| test/record-review-parity.test.ts | test | parity | parity | 89 | 3 | yes | record |
| test/record-stop-parity.test.ts | test | parity | parity | 94 | 2 | yes | record |
| test/release-automation.test.ts | test | parity | parity | 216 | 0 | yes | release |
| test/release-ci-evidence.test.ts | test | kept | none | 212 | 0 | no | release |
| test/release-cli-feed.test.ts | test | kept | none | 104 | 0 | yes | release |
| test/release-homebrew.test.ts | test | src-unit | src | 35 | 1 | yes | release |
| test/release-main-ci-evidence.test.ts | test | kept | none | 143 | 0 | yes | release |
| test/release-next-version.test.ts | test | kept | none | 39 | 0 | yes | release |
| test/release-nightly-workflow.test.ts | test | kept | none | 323 | 0 | yes | release |
| test/release-nightly.test.ts | test | src-unit | src | 206 | 1 | yes | release |
| test/release-npm.test.ts | test | src-unit | src | 87 | 1 | yes | release |
| test/release-pair-build.test.ts | test | src-unit | src | 84 | 2 | yes | release |
| test/release-pair-orchestration.test.ts | test | kept | none | 43 | 0 | yes | release |
| test/release-pair-packages.test.ts | test | src-unit | src | 68 | 1 | yes | release |
| test/release-prepare.test.ts | test | kept | none | 121 | 0 | yes | release |
| test/release-workflow.test.ts | test | parity | parity | 432 | 0 | yes | release |
| test/remote-ask.test.ts | test | src-unit | src | 137 | 9 | yes | remote |
| test/remote-attempt.test.ts | test | src-unit | src | 352 | 10 | yes | remote |
| test/remote-committed-work.test.ts | test | src-unit | src | 19 | 1 | yes | remote |
| test/remote-e2e.test.ts | test | src-unit | src | 252 | 11 | yes | remote |
| test/remote-eligibility-plugin.test.ts | test | src-unit | src | 52 | 2 | yes | remote |
| test/remote-eligibility.test.ts | test | src-unit | src | 124 | 6 | yes | remote |
| test/remote-hosts.test.ts | test | src-unit | src | 385 | 8 | yes | remote |
| test/remote-preflight-facts.test.ts | test | src-unit | src | 13 | 1 | yes | remote |
| test/remote-run-io.test.ts | test | binary-e2e | e2e | 1418 | 52 | yes | remote |
| test/remote-ssh.test.ts | test | src-unit | src | 95 | 4 | yes | remote |
| test/remote-transfer.test.ts | test | src-unit | src | 299 | 7 | yes | remote |
| test/remote-usage.test.ts | test | src-unit | src | 175 | 8 | yes | remote |
| test/remote-viewer-admission.test.ts | test | src-unit | src | 28 | 1 | yes | remote |
| test/remote-viewer-backoff.test.ts | test | src-unit | src | 13 | 1 | yes | remote |
| test/removable-volume.test.ts | test | src-unit | src | 23 | 1 | yes | removable |
| test/render-accounts.test.ts | test | src-unit | src | 135 | 14 | yes | render |
| test/render-line.test.ts | test | src-unit | src | 63 | 2 | yes | render |
| test/render.test.ts | test | src-unit | src | 53 | 4 | yes | render.test.ts |
| test/repo-branch-cache.test.ts | test | src-unit | src | 96 | 1 | yes | repo |
| test/repo-native-parity.test.ts | test | parity | parity | 49 | 1 | yes | repo |
| test/repos.test.ts | test | src-unit | src | 173 | 10 | yes | repos.test.ts |
| test/review-eligibility.test.ts | test | src-unit | src | 88 | 11 | yes | review |
| test/review-verdicts.test.ts | test | src-unit | src | 158 | 10 | yes | review |
| test/route-explanation.test.ts | test | src-unit | src | 44 | 2 | yes | route |
| test/routing-balance.test.ts | test | src-unit | src | 46 | 2 | yes | routing |
| test/routing-eligibility.test.ts | test | src-unit | src | 56 | 6 | yes | routing |
| test/routing-worktree-regression.test.ts | test | src-unit | src | 237 | 16 | yes | routing |
| test/run-spawn-launch-parity.test.ts | test | parity | parity | 99 | 1 | yes | run |
| test/run-spawn-parity.test.ts | test | parity | parity | 99 | 1 | yes | run |
| test/runner-check-model.test.ts | test | src-unit | src | 68 | 2 | yes | runner |
| test/runner-check.test.ts | test | src-unit | src | 161 | 4 | yes | runner |
| test/runner-delegate-model.test.ts | test | src-unit | src | 187 | 9 | yes | runner |
| test/runner-eligibility.test.ts | test | src-unit | src | 48 | 4 | yes | runner |
| test/runner-id.test.ts | test | src-unit | src | 79 | 8 | yes | runner |
| test/runner-models.test.ts | test | src-unit | src | 169 | 3 | yes | runner |
| test/runner-owned-broken.test.ts | test | src-unit | src | 119 | 9 | yes | runner |
| test/runner-owned-direct-process.test.ts | test | src-unit | src | 53 | 4 | yes | runner |
| test/runner-queue.test.ts | test | src-unit | src | 148 | 9 | yes | runner |
| test/runner-routing.test.ts | test | src-unit | src | 251 | 9 | yes | runner |
| test/runner.test.ts | test | src-unit | src | 651 | 21 | yes | runner.test.ts |
| test/runners-config-model.test.ts | test | src-unit | src | 82 | 3 | yes | runners |
| test/runners-config.test.ts | test | src-unit | src | 47 | 4 | yes | runners |
| test/rust-goldens.test.ts | test | kept | none | 16 | 0 | yes | rust |
| test/self-signing-cert.test.ts | test | kept | none | 28 | 0 | yes | self |
| test/send-cli.test.ts | test | src-unit | src | 52 | 2 | yes | send |
| test/send.test.ts | test | src-unit | src | 373 | 15 | yes | send.test.ts |
| test/serve-auto-clean.test.ts | test | src-unit | src | 51 | 2 | yes | serve |
| test/serve-background-worker.test.ts | test | src-unit | src | 288 | 3 | yes | serve |
| test/serve-cached-auth.test.ts | test | src-unit | src | 60 | 2 | yes | serve |
| test/serve-caller-wake.test.ts | test | src-unit | src | 109 | 6 | yes | serve |
| test/serve-certification-tick.test.ts | test | src-unit | src | 40 | 2 | yes | serve |
| test/serve-health-isolation.test.ts | test | binary-e2e | e2e | 96 | 0 | no | serve |
| test/serve-http-assistant.test.ts | test | src-unit | src | 147 | 6 | yes | serve |
| test/serve-internal.test.ts | test | binary-e2e | e2e | 132 | 3 | yes | serve |
| test/serve-listener-proxy.test.ts | test | src-unit | src | 82 | 1 | yes | serve |
| test/serve-no-sync-repo-io.test.ts | test | src-unit | src | 71 | 5 | yes | serve |
| test/serve-plugin-native.test.ts | test | src-unit | src | 303 | 2 | yes | serve |
| test/serve-read-cache.test.ts | test | src-unit | src | 60 | 1 | yes | serve |
| test/serve-snapshot-cache.test.ts | test | src-unit | src | 43 | 2 | yes | serve |
| test/serve-status-cache.test.ts | test | src-unit | src | 55 | 2 | yes | serve |
| test/serve-task-supervisor.test.ts | test | src-unit | src | 51 | 3 | yes | serve |
| test/serve-tui-human.test.ts | test | src-unit | src | 58 | 3 | yes | serve |
| test/serve-usage-refresh.test.ts | test | src-unit | src | 66 | 3 | yes | serve |
| test/server-build-incremental.test.ts | test | kept | none | 27 | 0 | yes | server |
| test/service-label.test.ts | test | src-unit | src | 31 | 1 | yes | service |
| test/service-uninstall.test.ts | test | src-unit | src | 131 | 5 | yes | service |
| test/service-unit.test.ts | test | src-unit | src | 53 | 1 | yes | service |
| test/service-update-parity.test.ts | test | parity | parity | 153 | 9 | yes | service |
| test/service.test.ts | test | binary-e2e | e2e | 474 | 6 | yes | service.test.ts |
| test/session-agent-identity.test.ts | test | src-unit | src | 102 | 2 | yes | session |
| test/session-agent-overhead.test.ts | test | src-unit | src | 138 | 8 | yes | session |
| test/session-agent-policy.test.ts | test | src-unit | src | 108 | 3 | yes | session |
| test/session-agent-probe.test.ts | test | plugin | plugin | 44 | 1 | yes | session |
| test/session-agent-reporting.test.ts | test | plugin | plugin | 188 | 5 | yes | session |
| test/session-agent-selection.test.ts | test | src-unit | src | 22 | 2 | yes | session |
| test/session-attach-lifecycle.test.ts | test | src-unit | src | 195 | 2 | yes | session |
| test/session-attach-selection.test.ts | test | src-unit | src | 62 | 3 | yes | session |
| test/session-attempt-recording.test.ts | test | src-unit | src | 80 | 5 | yes | session |
| test/session-check-stop.test.ts | test | src-unit | src | 210 | 7 | yes | session |
| test/session-cli-flow-parity.test.ts | test | parity | parity | 14 | 0 | yes | session |
| test/session-command.test.ts | test | src-unit | src | 8 | 1 | yes | session |
| test/session-control-parity.test.ts | test | parity | parity | 25 | 0 | yes | session |
| test/session-conversation.test.ts | test | src-unit | src | 195 | 14 | yes | session |
| test/session-create.test.ts | test | src-unit | src | 253 | 5 | yes | session |
| test/session-dispatch-parity.test.ts | test | parity | parity | 14 | 0 | no | session |
| test/session-file-viewer.test.tsx | test | kept | none | 277 | 0 | yes | session |
| test/session-files.test.ts | test | src-unit | src | 160 | 5 | yes | session |
| test/session-host-parity.test.ts | test | parity | parity | 168 | 6 | yes | session |
| test/session-interactive.test.ts | test | src-unit | src | 179 | 4 | yes | session |
| test/session-keys-parity.test.ts | test | parity | parity | 15 | 0 | yes | session |
| test/session-lifecycle-bridge-access.test.ts | test | src-unit | src | 38 | 4 | yes | session |
| test/session-limit.test.ts | test | src-unit | src | 172 | 12 | yes | session |
| test/session-link-flow.test.tsx | test | src-unit | src | 25 | 2 | yes | session |
| test/session-link.test.ts | test | src-unit | src | 36 | 6 | yes | session |
| test/session-multiple.test.ts | test | src-unit | src | 490 | 27 | yes | session |
| test/session-native-identity.test.ts | test | src-unit | src | 23 | 1 | yes | session |
| test/session-ops-parity.test.ts | test | parity | parity | 355 | 12 | yes | session |
| test/session-ops-reference.ts | support | src-unit | src | 62 | 3 | yes |  |
| test/session-params-parity.test.ts | test | parity | parity | 87 | 2 | yes | session |
| test/session-protocol.test.ts | test | src-unit | src | 116 | 8 | yes | session |
| test/session-replay-gate.test.ts | test | kept | none | 21 | 0 | yes | session |
| test/session-routes-parity.test.ts | test | parity | parity | 14 | 0 | yes | session |
| test/session-screen-checkpoint.test.ts | test | src-unit | src | 60 | 1 | yes | session |
| test/session-service.test.ts | test | src-unit | src | 132 | 9 | yes | session |
| test/session-surfaces-parity.test.ts | test | parity | parity | 37 | 1 | yes | session |
| test/session-takeover.test.ts | test | src-unit | src | 432 | 20 | yes | session |
| test/session-transport-parity.test.ts | test | parity | parity | 221 | 2 | yes | session |
| test/session-viewers.test.ts | test | src-unit | src | 421 | 3 | yes | session |
| test/session-ws-codec.test.ts | test | src-unit | src | 29 | 2 | yes | session |
| test/session-ws-handler-parity.test.ts | test | parity | parity | 150 | 2 | yes | session |
| test/session-ws.test.ts | test | src-unit | src | 298 | 7 | yes | session |
| test/session.test.ts | test | src-unit | src | 980 | 32 | yes | session.test.ts |
| test/setup-checklist.test.ts | test | src-unit | src | 33 | 3 | yes | setup |
| test/setup-command.test.ts | test | src-unit | src | 148 | 5 | yes | setup |
| test/setup-detect-safety.test.ts | test | src-unit | src | 104 | 3 | yes | setup |
| test/setup-git-isolation.test.ts | test | kept | none | 75 | 0 | yes | setup |
| test/setup-guided.test.ts | test | src-unit | src | 199 | 19 | yes | setup |
| test/setup-health-op.test.ts | test | src-unit | src | 171 | 6 | yes | setup |
| test/setup-health-store.test.ts | test | src-unit | src | 106 | 2 | yes | setup |
| test/setup-health-update-stamp.test.ts | test | src-unit | src | 23 | 2 | yes | setup |
| test/setup-health-view-model.test.ts | test | src-unit | src | 319 | 4 | yes | setup |
| test/setup-reviewed-cache.test.ts | test | src-unit | src | 84 | 3 | yes | setup |
| test/setup-snapshot-probe.test.ts | test | src-unit | src | 71 | 4 | yes | setup |
| test/setup-toolchain-home.test.ts | test | kept | none | 31 | 0 | yes | setup |
| test/setup.ts | support | src-unit | src | 118 | 2 | yes |  |
| test/short-title.test.ts | test | src-unit | src | 79 | 1 | yes | short |
| test/sign-local.test.ts | test | src-unit | src | 110 | 2 | yes | sign |
| test/slots.test.ts | test | src-unit | src | 98 | 4 | yes | slots.test.ts |
| test/sp02-admission.test.ts | test | src-unit | src | 99 | 3 | yes | sp02 |
| test/sp02-authority.test.ts | test | src-unit | src | 83 | 1 | yes | sp02 |
| test/sp02-capability-protocol.test.ts | test | src-unit | src | 42 | 2 | yes | sp02 |
| test/sp02-capability-security.test.ts | test | src-unit | src | 348 | 4 | yes | sp02 |
| test/sp02-host-integration.test.ts | test | src-unit | src | 46 | 5 | yes | sp02 |
| test/sp02-plugin-compatibility.test.ts | test | src-unit | src | 66 | 4 | yes | sp02 |
| test/sp02-registry-authority.test.ts | test | src-unit | src | 101 | 1 | yes | sp02 |
| test/sp02-result-staging.test.ts | test | src-unit | src | 154 | 2 | yes | sp02 |
| test/sp02-result-transport.test.ts | test | src-unit | src | 112 | 3 | yes | sp02 |
| test/sp02-rpc-authority.test.ts | test | src-unit | src | 100 | 5 | yes | sp02 |
| test/sp02-sdk-usage.test.ts | test | kept | none | 70 | 0 | no | sp02 |
| test/sp02-sdk-utf8.test.ts | test | kept | none | 91 | 0 | no | sp02 |
| test/sp02-spawn-security.test.ts | test | src-unit | src | 201 | 2 | yes | sp02 |
| test/sp02-usage-broker.test.ts | test | src-unit | src | 105 | 4 | yes | sp02 |
| test/sp02-usage-json.test.ts | test | src-unit | src | 46 | 1 | yes | sp02 |
| test/sp02-usage-state.test.ts | test | src-unit | src | 415 | 4 | yes | sp02 |
| test/sqlite-cross-runtime-proof.test.ts | test | src-unit | src | 137 | 3 | yes | sqlite |
| test/sqlite-startup-contention.test.ts | test | src-unit | src | 335 | 9 | yes | sqlite |
| test/ssh-config-parity.test.ts | test | parity | parity | 57 | 1 | yes | ssh |
| test/ssh-config.test.ts | test | src-unit | src | 44 | 1 | yes | ssh |
| test/status-broker-parts-bridge.test.ts | test | src-unit | src | 251 | 7 | yes | status |
| test/status.test.ts | test | src-unit | src | 135 | 6 | yes | status.test.ts |
| test/statusline-counts.test.ts | test | src-unit | src | 53 | 4 | yes | statusline |
| test/stdio-transport-parity.test.ts | test | parity | parity | 17 | 2 | yes | stdio |
| test/strategy-build.test.ts | test | src-unit | src | 25 | 2 | yes | strategy |
| test/strategy-differential.test.ts | test | parity | parity | 324 | 2 | yes | strategy |
| test/strategy-service.test.ts | test | src-unit | src | 177 | 7 | yes | strategy |
| test/strategy-write-parity.test.ts | test | parity | parity | 156 | 2 | yes | strategy |
| test/strategy.test.ts | test | src-unit | src | 177 | 1 | yes | strategy.test.ts |
| test/supervisor-alerts.test.ts | test | src-unit | src | 50 | 4 | yes | supervisor |
| test/supervisor-orphan.test.ts | test | src-unit | src | 129 | 1 | yes | supervisor |
| test/supervisor-progress.test.ts | test | src-unit | src | 256 | 9 | yes | supervisor |
| test/supervisor-resume.test.ts | test | src-unit | src | 81 | 6 | yes | supervisor |
| test/supervisor-run.test.ts | test | src-unit | src | 219 | 2 | yes | supervisor |
| test/supervisor-supervise.test.ts | test | src-unit | src | 90 | 2 | yes | supervisor |
| test/supervisor-worktree.test.ts | test | src-unit | src | 64 | 2 | yes | supervisor |
| test/task-detail.test.ts | test | src-unit | src | 121 | 7 | yes | task |
| test/task-diff-parity.test.ts | test | parity | parity | 112 | 3 | yes | task |
| test/task-display-title.test.ts | test | src-unit | src | 56 | 3 | yes | task |
| test/task-get-performance.test.ts | test | src-unit | src | 157 | 4 | yes | task |
| test/task-output-preview.test.ts | test | src-unit | src | 28 | 1 | yes | task |
| test/task-preparation-worker-helper.ts | support | src-unit | src | 21 | 1 | yes |  |
| test/task-resolution.test.ts | test | src-unit | src | 129 | 9 | yes | task |
| test/task-rev.test.ts | test | src-unit | src | 129 | 4 | yes | task |
| test/task-review-request.test.ts | test | src-unit | src | 66 | 6 | yes | task |
| test/task-send-bridge-access.test.ts | test | src-unit | src | 106 | 6 | yes | task |
| test/task-states.test.ts | test | src-unit | src | 38 | 10 | yes | task |
| test/task-supervision.test.ts | test | src-unit | src | 53 | 3 | yes | task |
| test/task-wait-settled-parity.test.ts | test | parity | parity | 38 | 1 | yes | task |
| test/tasks-admission-golden.test.ts | test | src-unit | src | 223 | 13 | yes | tasks |
| test/tasks-changes.test.ts | test | src-unit | src | 116 | 2 | yes | tasks |
| test/tasks-delivery-lock.test.ts | test | src-unit | src | 78 | 5 | yes | tasks |
| test/tasks-drain-positions.test.ts | test | src-unit | src | 23 | 2 | yes | tasks |
| test/tasks-handover-commit.test.ts | test | src-unit | src | 100 | 9 | yes | tasks |
| test/tasks-handover-replace.test.ts | test | src-unit | src | 91 | 12 | yes | tasks |
| test/tasks-handover-service.test.ts | test | src-unit | src | 105 | 6 | yes | tasks |
| test/tasks-handover-stop.test.ts | test | src-unit | src | 90 | 10 | yes | tasks |
| test/tasks-handover.test.ts | test | src-unit | src | 72 | 7 | yes | tasks |
| test/tasks-preparation-lock.test.ts | test | src-unit | src | 65 | 4 | yes | tasks |
| test/tasks-retention.test.ts | test | src-unit | src | 189 | 11 | yes | tasks |
| test/tasks-runner-lock.test.ts | test | src-unit | src | 81 | 4 | yes | tasks |
| test/tasks-rust-admission-parity.test.ts | test | parity | parity | 51 | 3 | yes | tasks |
| test/tasks-rust-store-parity.test.ts | test | parity | parity | 417 | 3 | yes | tasks |
| test/tasks-sqlite.test.ts | test | src-unit | src | 162 | 1 | yes | tasks |
| test/tasks-stop-pending-supervision.test.ts | test | src-unit | src | 328 | 7 | yes | tasks |
| test/tasks-store-busy.test.ts | test | src-unit | src | 26 | 1 | yes | tasks |
| test/tasks-store-ids.test.ts | test | src-unit | src | 27 | 1 | yes | tasks |
| test/tasks-store-import-scan.test.ts | test | src-unit | src | 109 | 1 | yes | tasks |
| test/tasks-store-live-index.test.ts | test | src-unit | src | 43 | 1 | yes | tasks |
| test/tasks-store-reviewed.test.ts | test | src-unit | src | 97 | 1 | yes | tasks |
| test/tasks-store.test.ts | test | src-unit | src | 160 | 4 | yes | tasks |
| test/temp-roots.ts | support | kept | none | 54 | 0 | no |  |
| test/terminal-links.test.ts | test | kept | none | 72 | 0 | no | terminal |
| test/terminal-login-shell.test.ts | test | src-unit | src | 34 | 1 | yes | terminal |
| test/terminal-open.test.ts | test | src-unit | src | 170 | 5 | yes | terminal |
| test/terminal-parity.test.ts | test | parity | parity | 132 | 5 | yes | terminal |
| test/terminal-parts-bridge.test.ts | test | src-unit | src | 86 | 5 | yes | terminal |
| test/terminal-runtime.test.ts | test | src-unit | src | 17 | 1 | yes | terminal |
| test/terminal-workspace.test.ts | test | src-unit | src | 99 | 4 | yes | terminal |
| test/test-sandbox.test.ts | test | kept | none | 15 | 0 | no | test |
| test/test-temp-roots.test.ts | test | kept | none | 114 | 0 | yes | test |
| test/tokens-extract.test.ts | test | src-unit | src | 92 | 1 | yes | tokens |
| test/tokens-rollup.test.ts | test | src-unit | src | 156 | 8 | yes | tokens |
| test/tokens-store.test.ts | test | src-unit | src | 113 | 4 | yes | tokens |
| test/transport-parity.test.ts | test | parity | parity | 220 | 4 | yes | transport |
| test/ui-check.test.ts | test | kept | none | 315 | 0 | no | ui |
| test/ui-evidence.test.ts | test | kept | none | 232 | 0 | no | ui |
| test/ui-ready.test.ts | test | kept | none | 86 | 0 | no | ui |
| test/undo-prune.test.ts | test | src-unit | src | 63 | 2 | yes | undo |
| test/update-check.test.ts | test | src-unit | src | 160 | 5 | yes | update |
| test/update-commands.test.ts | test | src-unit | src | 28 | 1 | yes | update |
| test/update-e2e.test.ts | test | src-unit | src | 68 | 2 | yes | update |
| test/update-front-door.test.ts | test | src-unit | src | 21 | 1 | yes | update |
| test/update-install-sh.test.ts | test | src-unit | src | 442 | 1 | yes | update |
| test/update-manifest.test.ts | test | src-unit | src | 14 | 1 | yes | update |
| test/update-refresh.test.ts | test | src-unit | src | 60 | 5 | yes | update |
| test/update-release-compiled.test.ts | test | src-unit | src | 55 | 1 | yes | update |
| test/update-release.test.ts | test | src-unit | src | 82 | 1 | yes | update |
| test/update-replace.test.ts | test | src-unit | src | 312 | 7 | yes | update |
| test/update-run.test.ts | test | src-unit | src | 532 | 8 | yes | update |
| test/update-upgrade-paths.test.ts | test | src-unit | src | 112 | 4 | yes | update |
| test/update-version.test.ts | test | src-unit | src | 108 | 3 | yes | update |
| test/upgrade-compat.test.ts | test | src-unit | src | 114 | 10 | yes | upgrade |
| test/upgrade-visibility.test.tsx | test | src-unit | src | 86 | 4 | yes | upgrade |
| test/usage-accounts.test.ts | test | src-unit | src | 205 | 7 | yes | usage |
| test/usage-cross-surface.test.tsx | test | src-unit | src | 223 | 14 | yes | usage |
| test/usage-fixtures.ts | support | src-unit | src | 77 | 1 | yes |  |
| test/usage-freshness.test.ts | test | src-unit | src | 74 | 3 | yes | usage |
| test/usage-import-rule.test.ts | test | kept | none | 52 | 0 | no | usage |
| test/usage-incremental.test.ts | test | src-unit | src | 219 | 3 | yes | usage |
| test/usage-index.test.ts | test | src-unit | src | 38 | 3 | yes | usage |
| test/usage-metered-cost.test.ts | test | src-unit | src | 53 | 2 | yes | usage |
| test/usage-metered-evidence.test.ts | test | src-unit | src | 20 | 2 | yes | usage |
| test/usage-plugin-cutover.test.ts | test | src-unit | src | 23 | 6 | yes | usage |
| test/usage-plugin-fixtures.ts | support | src-unit | src | 45 | 3 | yes |  |
| test/usage-refresh-adapter.test.ts | test | src-unit | src | 93 | 4 | yes | usage |
| test/usage-refresh-coordinator.test.ts | test | src-unit | src | 118 | 6 | yes | usage |
| test/usage-refresh-parity.test.ts | test | parity | parity | 73 | 2 | yes | usage |
| test/usage-semantic-contracts.test.ts | test | src-unit | src | 105 | 4 | yes | usage |
| test/usage-state-contract.test.ts | test | src-unit | src | 373 | 12 | yes | usage |
| test/usage-state-sweep.test.ts | test | src-unit | src | 48 | 2 | yes | usage |
| test/usage-store.test.ts | test | src-unit | src | 182 | 5 | yes | usage |
| test/usage-view.test.ts | test | src-unit | src | 154 | 3 | yes | usage |
| test/util.test.ts | test | src-unit | src | 46 | 2 | yes | util.test.ts |
| test/v2-parity.test.ts | test | parity | parity | 107 | 3 | yes | v2 |
| test/verdict.test.ts | test | src-unit | src | 63 | 3 | yes | verdict.test.ts |
| test/verify.test.ts | test | src-unit | src | 123 | 1 | yes | verify.test.ts |
| test/view-model-capacity.test.ts | test | src-unit | src | 74 | 7 | yes | view |
| test/view-model-client-migration.test.ts | test | src-unit | src | 48 | 3 | yes | view |
| test/view-model-copy.test.ts | test | src-unit | src | 83 | 3 | yes | view |
| test/view-model-dispatch.test.ts | test | src-unit | src | 223 | 3 | yes | view |
| test/view-model-eligibility.test.ts | test | src-unit | src | 33 | 5 | yes | view |
| test/view-model-panel.test.ts | test | src-unit | src | 21 | 2 | yes | view |
| test/view-model-route-explain.test.ts | test | src-unit | src | 70 | 2 | yes | view |
| test/view-model-selectors.test.ts | test | src-unit | src | 83 | 4 | yes | view |
| test/view-model-spend.test.ts | test | src-unit | src | 11 | 1 | yes | view |
| test/view-model-task-tree.test.ts | test | src-unit | src | 327 | 3 | yes | view |
| test/view-model-time.test.ts | test | src-unit | src | 53 | 3 | yes | view |
| test/view-model-titles.test.ts | test | src-unit | src | 22 | 1 | yes | view |
| test/view-model-updates.test.ts | test | src-unit | src | 125 | 4 | yes | view |
| test/view-model-words.test.ts | test | src-unit | src | 129 | 6 | yes | view |
| test/work-grant-authorize.test.ts | test | src-unit | src | 101 | 5 | yes | work |
| test/workflow-attention-ui.test.ts | test | src-unit | src | 376 | 5 | yes | workflow |
| test/workflow-auto.test.ts | test | src-unit | src | 313 | 14 | yes | workflow |
| test/workflow-budget.test.ts | test | src-unit | src | 503 | 16 | yes | workflow |
| test/workflow-cli.test.ts | test | src-unit | src | 254 | 9 | yes | workflow |
| test/workflow-condition.test.ts | test | src-unit | src | 77 | 1 | yes | workflow |
| test/workflow-engine.test.ts | test | src-unit | src | 1325 | 12 | yes | workflow |
| test/workflow-format.test.ts | test | src-unit | src | 317 | 3 | yes | workflow |
| test/workflow-ops.test.ts | test | src-unit | src | 360 | 12 | yes | workflow |
| test/workflow-orchestrator-scope.test.ts | test | src-unit | src | 214 | 14 | yes | workflow |
| test/workflow-orchestrator.test.ts | test | src-unit | src | 2630 | 83 | yes | workflow |
| test/workflow-round3-minors.test.ts | test | src-unit | src | 165 | 17 | yes | workflow |
| test/workflow-round4-minors.test.ts | test | src-unit | src | 226 | 17 | yes | workflow |
| test/workflow-round5-h1.test.ts | test | src-unit | src | 145 | 11 | yes | workflow |
| test/workflow-round5-h3.test.ts | test | src-unit | src | 58 | 3 | yes | workflow |
| test/workflow-round5-minors.test.ts | test | src-unit | src | 306 | 17 | yes | workflow |
| test/workflow-round5-n52.test.ts | test | src-unit | src | 104 | 4 | yes | workflow |
| test/workflow-round5-n53-n54.test.ts | test | src-unit | src | 137 | 12 | yes | workflow |
| test/workflow-round6-i1.test.ts | test | src-unit | src | 129 | 12 | yes | workflow |
| test/workflow-round6-i2.test.ts | test | src-unit | src | 99 | 3 | yes | workflow |
| test/workflow-round6-i3.test.ts | test | src-unit | src | 139 | 5 | yes | workflow |
| test/workflow-round6-i4.test.ts | test | src-unit | src | 45 | 3 | yes | workflow |
| test/workflow-round6-minors.test.ts | test | src-unit | src | 338 | 15 | yes | workflow |
| test/workflow-round7-j4.test.ts | test | src-unit | src | 45 | 3 | yes | workflow |
| test/workflow-run-grant.test.ts | test | src-unit | src | 469 | 18 | yes | workflow |
| test/workflow-scope.test.ts | test | src-unit | src | 165 | 9 | yes | workflow |
| test/workflow-stop-error-sanitize.test.ts | test | src-unit | src | 94 | 1 | yes | workflow |
| test/workflow-store.test.ts | test | src-unit | src | 217 | 3 | yes | workflow |
| test/workflow-template.test.ts | test | src-unit | src | 124 | 1 | yes | workflow |
| test/workflow-tick.test.ts | test | src-unit | src | 524 | 11 | yes | workflow |
| test/workflow-wakeups.test.ts | test | src-unit | src | 169 | 3 | yes | workflow |

## Data files

| Group | Files | Referenced by buckets |
|---|---:|---|
| __snapshots__ | 6 | plugin, src-unit, parity |
| fixtures/acp-spike | 2 | unreferenced |
| fixtures/api-error-contract.json | 1 | src-unit |
| fixtures/app-route-parity.json | 1 | parity |
| fixtures/assistant-executor | 1 | unreferenced |
| fixtures/bin | 3 | src-unit, binary-e2e, parity |
| fixtures/claude-weekly-limit.txt | 1 | src-unit |
| fixtures/codex-app-server.mjs | 1 | unreferenced |
| fixtures/codex-team-limit.txt | 1 | src-unit |
| fixtures/config-settings | 3 | src-unit, parity |
| fixtures/config-writes-goldens.json | 1 | parity, src-unit |
| fixtures/dashboard-frame | 3 | parity |
| fixtures/desktop-update | 11 | src-unit, kept |
| fixtures/engine | 1 | kept |
| fixtures/host-broker | 1 | unreferenced |
| fixtures/install | 4 | src-unit, parity |
| fixtures/issue-import | 5 | unreferenced |
| fixtures/js-trim-parity.json | 1 | parity |
| fixtures/link | 3 | src-unit |
| fixtures/live-control | 1 | src-unit, kept |
| fixtures/mcp | 2 | parity |
| fixtures/models-dev-sample.json | 1 | plugin |
| fixtures/native-listener-adoption.py | 1 | kept |
| fixtures/native-observer | 1 | kept |
| fixtures/native-permission | 1 | kept |
| fixtures/native-title-goldens.json | 1 | unreferenced |
| fixtures/opencode-acp.mjs | 1 | plugin |
| fixtures/opencode-retry-524.ansi | 1 | unreferenced |
| fixtures/opencode-retry-ratelimit.ansi | 1 | unreferenced |
| fixtures/opencode-stats-cost.json | 1 | unreferenced |
| fixtures/opencode-working-source.ansi | 1 | unreferenced |
| fixtures/orca | 35 | src-unit, parity |
| fixtures/orca-account-list.json | 1 | unreferenced |
| fixtures/owning-call-methods.json | 1 | src-unit |
| fixtures/p6e | 1 | parity |
| fixtures/parity-basic | 2 | parity |
| fixtures/plugin-manifest-parity.json | 1 | parity |
| fixtures/plugin-operation-number-parity.json | 1 | unreferenced |
| fixtures/plugin-public-parity.json | 1 | unreferenced |
| fixtures/plugin-strategy-byte-parity.json | 1 | unreferenced |
| fixtures/policy-observations | 1 | src-unit |
| fixtures/protocol-v2 | 11 | src-unit, parity |
| fixtures/read-model | 2 | src-unit |
| fixtures/service-update-boundaries.json | 1 | parity |
| fixtures/session-ops | 16 | parity, src-unit |
| fixtures/sessions | 10 | parity |
| fixtures/strategy-doc | 3 | unreferenced |
| fixtures/strategy-read | 7 | parity |
| fixtures/task-admission | 15 | parity, src-unit |
| fixtures/task-diff | 1 | parity |
| fixtures/tokens | 9 | unreferenced |
| fixtures/tray-routes.json | 1 | src-unit |
| fixtures/ui | 5 | kept, src-unit |
| fixtures/ui-check | 4 | kept |
| fixtures/upgrade | 78 | src-unit |
| parity-harness.md | 1 | unreferenced |
| tokens-rollup.test.ts.bak | 1 | unreferenced |

## Unreferenced data

| Group | Files |
|---|---:|
| fixtures/acp-spike | 2 |
| fixtures/assistant-executor | 1 |
| fixtures/codex-app-server.mjs | 1 |
| fixtures/host-broker | 1 |
| fixtures/issue-import | 5 |
| fixtures/native-title-goldens.json | 1 |
| fixtures/opencode-retry-524.ansi | 1 |
| fixtures/opencode-retry-ratelimit.ansi | 1 |
| fixtures/opencode-stats-cost.json | 1 |
| fixtures/opencode-working-source.ansi | 1 |
| fixtures/orca-account-list.json | 1 |
| fixtures/plugin-operation-number-parity.json | 1 |
| fixtures/plugin-public-parity.json | 1 |
| fixtures/plugin-strategy-byte-parity.json | 1 |
| fixtures/strategy-doc | 3 |
| fixtures/tokens | 9 |
| parity-harness.md | 1 |
| tokens-rollup.test.ts.bak | 1 |
