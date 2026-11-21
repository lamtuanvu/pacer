# Pacer

A right-sidebar `"ui":"html"` panel (`src/panel.html` + `src/panel.ts`) and the plugin's own worker (`src/worker.ts`). The frame script calls `orca.plugin.request`/`orca.plugin.on`, the worker answers with `orca.panels.handle`, keeps the last-seen event seq in `orca.storage` and tells every open panel with `orca.panels.post`; `src/protocol.ts` types both sides. Orca transpiles every file when it loads, so there is no build step: save and the panel or worker reloads (a worker reload drops its in-memory state, so keep what must last in storage).

All non-trivial panel logic lives in `src/panel-view.ts`: a pure, DOM-free, `orca`-free view-model module, because Orca's `orca plugin check`/`orca/testing` mount() kit only supports `"ui":"components"` panels (`orca plugin check .` prints `No components panels or custom editors to check.` for this one). `orca plugin test .` runs `src/pacer-client.test.ts`, `src/panel-view.test.ts` and `src/worker.test.ts` in Node with `orca/testing`; `npx tsc -p .` type-checks against the typings `orca plugin types .` writes to `.orca/types/`. The html panel's own render (frame injection, the `html.dark` class, keyboard/contrast) has no automated check and needs manual or live-Orca verification.

## Develop

```sh
orca plugin validate .
orca plugin dev watch .    # loads this folder into Orca and prints its logs and reloads; Ctrl-C unloads it
```

Orca names the publisher after where the plugin is installed from: the GitHub or GitLab owner of
its repository, or `local` for a folder. See
https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md.
