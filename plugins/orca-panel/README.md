# Pacer

A right-sidebar `"ui":"html"` panel (`src/panel.html` + `src/panel.ts`) and the plugin's own
worker (`src/worker.ts`). The frame shows the focused Orca worktree's delegated tasks only: needs-you items (review and
messages for the person), tasks with their status, and done (last 24h). The header shows the
planner's pace in one line; the status bar counts this worktree only. The frame
calls `orca.plugin.request` / `orca.plugin.on`; the worker answers with `orca.panels.handle`,
keeps the last-seen event seq in `orca.storage`, and tells every open panel with
`orca.panels.post`. `src/protocol.ts` types both sides. Orca transpiles every file when it loads,
so there is no build step.

All non-trivial panel logic lives in `src/panel-view.ts`: a pure, DOM-free, `orca`-free
view-model. The worker is an ordinary pacer v3 HTTP/SSE client (`src/pacer-client.ts`); it never
reimplements business rules — attention actions come from the service, plus the direct controls
listed in the design spec's Action model. `ui.open` is handled client-side by spawning
`open`/`xdg-open` with a `pacer://` deep link via `node:child_process` (Orca's trusted-worker is
Node, not Bun). Opening an Orca worktree uses host `workspace.open` and needs the
`workspace:write` capability (in addition to `storage:own` and `workspace:read`).

## Limitations

- **Accept/Reject `expect_rev`:** Accept/Reject omit `expect_rev` when the service no longer
  tracks the reviewed task. The service treats it as optional; a conflict surfaces as "Already
  handled elsewhere".
- **`tab:"answer"` deep links:** query forms (`needs-you?answer=<id>`) are rejected on
  `pacer://` (early `?` guard in `logic.rs`). Answer intents map to
  `pacer://sessions/<id>/answer`, which the desktop deep-link handler accepts.

`orca plugin test .` runs `src/pacer-client.test.ts`, `src/panel-view.test.ts` and
`src/worker.test.ts` in Node with `orca/testing`. `bun x tsc -p .` type-checks against the
typings `orca plugin types .` writes to `.orca/types/`.

## Add it from the pacer app

The macOS desktop app ships these files at `Contents/Resources/orca-panel`. Open
**Settings › Apps**, choose Orca, and follow Add to Orca. pacer shows what Orca
will grant and only continues after you press Allow and add.

From a terminal (same folder this README lives in, or the bundled path above):

```sh
pacer plugin install
pacer plugin install --approve <fingerprint>
```

## Develop

```sh
orca plugin validate .
orca plugin test .
bun x tsc -p . --noEmit
```

Live install / `orca plugin dev load` is done by the maintainer, not by agents working this tree.
Orca names the publisher after where the plugin is installed from: the GitHub or GitLab owner of
its repository, or `local` for a folder.
