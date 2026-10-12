# Orca link transport decision — 2026-10-12

Status: code-derived decisions recorded; human live verification pending.
Target: Orca 1.4.224, pluginApi 1. Source: the verified facts F1–F16 in
[Plan 6](../plans/2026-10-12-pacer-orca-plugin.md), which take precedence over
the earlier spec's assumptions. This record carries the plan's verification
provenance; it does not claim a new inspection or a successful live spike.

Run [S1–S6](../../../orca-plugin/spike/CHECKLIST.md) with human UI consent.
Replace `PENDING` with dated observations, including failures. Rows without a
direct live probe retain their code/disk/CLI provenance rather than implying
that a successful spike verifies every detail of the host API.

| fact | verified-by | live result (S1..S6) | consequence |
|---|---|---|---|
| F1: strict manifest v1; canonical identity is publisher.id; API experimental | code: plugin-manifest.js; disk: bundled launch manifests | PENDING (S1 enablement) | Use orca-plugin.json, existing fields, and pacer.pacer-spike identity. |
| F2: commands, panels and closed event contribution set | code: contribution schemas | PENDING (S1, S3, S5, S6) | Worker commands require main; events require events:subscribe. |
| F3: seven capability kinds; no network capability | code: plugin-capabilities.js | PENDING (S1 enablement) | Never declare net:fetch or process:exec. |
| F4: host API methods, capability gates, panel restrictions and limits | code: plugin-host-api.js | PENDING (S1–S4) | Explicit terminal handle; notification title 120/body 1000; panels cannot read storage. |
| F5: worktree and agent event payloads | code: plugin-events.js | PENDING (S5 event logs) | Use paneKey and worktree metadata; event schema's string bound is not status capacity. |
| F6: Node worker activation, filtered environment, command registration and idle reap | code: main/plugin-host-entry.js and app.asar | PENDING (S5, S6) | Register before activate resolves; logs alone do not prevent five-minute reap; PACER_HOME is filtered. |
| F7: worker is a normal Node process with full access | code: consent warning and fork flags | PENDING (S1) | Worker loopback HTTP is available without a manifest change; limit our usage deliberately. |
| F8: sandboxed panels, postMessage bridge, no live data push or storage access | code: plugin-panel-shell.js, plugin-panel-bridge.js; ctx7: hello-orca | PENDING (S3 button) | Render snapshots; reopen to refresh; use notifications for live signals. |
| F9: panel entry re-read on open; dev-path verifier no-op; consent fingerprint | code: load, verifier, discovery, plugin-consent-fingerprint.js | PENDING (S3) | Rewrite only a managed development-path panel, without instructional contributions. |
| F10: storage.json and settings.json paths; get reads disk without cache | code: storage wrapper in app.asar; disk: macOS userData | PENDING (S2 twice) | Storage bridge 3b preserves other keys and writes atomically; other platform paths remain inferred. |
| F11: UI install/discovery and consent; settings also live in profile-state.db | code and disk: plugins layout and profile data | PENDING (S1 enablement, cleanup) | Print UI setup steps; never edit Orca settings or installed plugin trees. |
| F12: no plugin CLI or CLI-to-plugin channel today | cli: orca --help and agent-context --json | PENDING (S1–S6 have no direct channel probe) | Transport 2 is gated and unavailable today. |
| F13: agents accepted but no consumer/profile format; instructional fingerprint | code: schema and content packs | PENDING (S1–S6 have no direct profile probe) | Defer agent profiles and omit instructional contributions. |
| F14: hooks or OSC feed a closed working/blocked/waiting/done enum | code: agent-status-types.js; disk: hooks and endpoint.env | PENDING (S1–S6 have no direct status-encoding probe) | Reject 3a; it carries at most two bits per event, not 256 characters of payload. |
| F15: runtime terminal handles, CLI metadata and inferred paneKey composition | cli: terminal list; coordinator-terminal.json fixture; code: readContext mapping | PENDING (S4 focused/cross-worktree send and paneKey comparison) | Advertise the console handle and verify scope; confirm tabId:leafId live. |
| F16: upstream hello-orca panel, command and events example | ctx7: stablyai/orca examples/plugins/hello-orca | PENDING (S3 panel bridge, S6 command) | Follow the default activate(ctx) and panel action/result protocol. |

## Decisions

- **D1. Transport priority uses the spec's numbering:** (1) worker `node:http`
  to loopback `pacer serve`; (2) auto-detected Orca channel, absent today (F12);
  (3) storage bridge **3b**, with the brain writing the `link` key in
  `plugins-data/pacer.pacer/storage.json` and the worker reading `storage.get`
  (F10). F7 establishes Node HTTP access; S1 remains the live confirmation.
  Reject 3a (F14). Drop the compact 256-character encoding; use notification
  text with title <=120 and body <=1000 instead.
- **D2. Panel:** render a snapshot into `<pluginRoot>/panel/live.html` only in
  a pacer-managed development path (F9). Reopen to refresh. Deliver live
  signals with `notifications.show`; panel buttons send commands to the console
  with `terminal.sendText`. There is no live host-to-panel data push (F8).
- **D3. Plugin to brain:** use `terminal.sendText` into the `pacer console`
  terminal. The snapshot advertises its handle with a 30-second heartbeat;
  reject missing or stale console records. The line format is `: pacer '<json>'`
  with correctly escaped single quotes. A mistaken send to a POSIX shell is
  inert because `:` is the null builtin. S4 determines cross-worktree scope.
- **D4. No instructional contributions in v1:** omit agents and keybindings
  so rewriting a development panel does not change consent. Agent profiles
  are deferred because there is no consumer or defined format (F13).
- **D5. Installation and writes:** pacer never edits Orca settings or `plugins/`.
  `pacer plugin install` writes `~/.pacer/orca-plugin/` and prints instructions
  for the human to add a development path and consent. In Orca's data, the real
  implementation writes only `plugins-data/pacer.pacer/storage.json` key `link`
  and, through `pacer plugin set`, that plugin's `settings.json`. Preserve user
  keys and refuse unreadable storage. The disposable spike uses its separate
  `pacer.pacer-spike` namespace.
- **D6. Worker Node usage:** only loopback HTTP to `127.0.0.1:<port>`, reading
  `<pacerHome>/token`, and writing `<pluginRoot>/panel/live.html` when
  `<pluginRoot>/.pacer-managed` exists. No child_process, other network access,
  or other file writes. The externally run spike scripts are preparation
  tools, not worker operations.
- **D7. Read-only serve:** add `GET /link` and outbox tailing in `/events`,
  without POST routes. Plugin-to-brain actions remain visible in the console.
  **Amendment, 2026-10-12 (0.1.7):** serve now has exactly one POST route,
  token-gated `POST /console/open`, because Orca 1.4.224 permits typing only in
  the active worktree and users should not start a console in each worktree by
  hand. The HTTP worker checks workspace context every five seconds; autoConsole
  defaults on and bridge/channel transports do nothing. The route accepts only
  bounded JSON terminal/branch selectors, resolves the worktree, checks live
  registrations and rate limits (one per worktree per 60 seconds, ten per hour),
  then uses server-owned pacer argv to create a console without `--focus`.
  Opens are logged as info alerts in link/outbox; task commands still go through
  the visible console. D6 remains unchanged: the worker spawns no subprocesses.

## Rejected options

- **Agent-status piggyback (3a):** F14's closed four-value enum drops arbitrary
  state strings. The event's <=256 validation bound does not admit a compact
  summary; encoding two bits per event is unsuitable for the link.
- **A task-delegation POST endpoint on pacer serve:** widens the attack surface by allowing a
  token holder to delegate work. Keep task actions
  visible in the console.
- **Spawning pacer from the worker:** goes beyond the declared capability model
  the user reviewed. Full Node access is disclosed by Orca, but pacer limits
  its worker to D6 and does not spawn processes.

## If live results contradict

- **S1 fails:** transport 1 becomes **needs upstream**. The plugin's
  `chooseTransport` order stays unchanged; HTTP simply never probes true.
- **S3 fails:** the panel stays the static placeholder with console buttons,
  and budget is shown through notifications only.
- **S4 refuses other worktrees:** the console must run in the worktree the user
  focuses, and notifications say so.
