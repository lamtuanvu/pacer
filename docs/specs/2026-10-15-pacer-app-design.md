# The pacer app: a web UI served by the daemon

Status: decisions recorded 2026-10-15. Builds on the [core contract](2026-10-14-core-contract-design.md) (protocol v2) and pairs with [endpoint executors](2026-10-15-endpoint-executors-design.md).

## Why

The Orca panel is now information only ([decision](../decisions/2026-10-15-orca-plugin-information-only.md)). People need one place to act: delegate, review, block executors, add accounts and executors, change the planner and strategy, finish setup and update. `pacer dashboard` covers part of that in a terminal; the owner asked for "a proper application with navigation that makes pacer easy to understand and use", not panel features bolted on.

## Decision: a web UI from the daemon

Core-contract decision 7 named a native desktop app with no web UI. On 2026-10-15 the owner chose option B instead:

- `pacer serve` (the daemon, already a launchd/systemd service) serves the app at `http://127.0.0.1:4317/app/`.
- It opens in any browser, or in an Orca browser tab.
- The same bundle can later be wrapped as a desktop app (Electron/Tauri) with no second codebase.

The app is an ordinary v2 client. It gets no capability the protocol does not have; every action below is a v2 operation that the CLI, MCP and other clients can call too.

## Success

- On a clean macOS account, someone who has installed pacer finishes setup, adds an executor, delegates a task, reviews it and changes the planner without a terminal (sign-in for Claude and Codex accounts is the one exception: the app shows the exact command to run).
- A page left open for an hour stays on its page and stays current.
- No other web page, and no other local user, can read or change pacer through the browser.
- No API key, account email or token appears in the app, its responses, its events or its logs.

## Screens

The [mockups](https://claude.ai/artifact/8XtCq2pK2qspk7Cdrk69hq) (built on the pacer design system) are the reference. Navigation is a left sidebar; at phone width it becomes a top bar with a menu.

| Screen | Answers | Acts |
|---|---|---|
| **Setup** (takes over until required items are done) | What is left before pacer works? | Choose the planner, install the service, connect agents (with consent), install the Orca panel |
| **Home** | Am I on pace? What needs me? Who runs next? | Delegate, open reviews, jump to broken executors |
| **Tasks** | What is running, waiting for review, finished? | Delegate, stop, retry, dismiss |
| **Task detail** | What did it do? | Live log, diff, accept/reject with note, retry on another executor |
| **Executors** | Which can take work, in what order, and why not the others? | Reorder, block/unblock, test, remove, add |
| **Add executor** | | Wizard: agent → account → (endpoint: URL, key, models) → test task; Ready only after the test passes |
| **Accounts & budgets** | Usage, windows, resets, sign-in state, data freshness per account | Add, remove, sign-in command |
| **Strategy** | How routing and pacing work, in plain language | Switch, edit pacing, preview changes, save as a named strategy |
| **Hosts** | Which remote machines can run work? | Add, remove, check |
| **Settings** | Planner, notifications, updates, versions, integrations | Change planner (with consent), notifications, check and apply updates |

Rules from the design system apply: one primary (ink) action per screen, status always in words, absolute times where a view is not live, numbers in tabular figures, no emoji, 44px touch targets in forms.

## Architecture

```
browser ──HTTP/SSE (cookie)──▶ pacer serve ──▶ core API (src/api/ops.ts) ──▶ core services
                                 │
                                 └── /app/* static files, embedded in the binary
```

### Frontend

- **Preact** with hooks, TypeScript and TSX, bundled by `Bun.build` (no Vite, no extra build tool). Preact is the only new runtime dependency; it ships inside the bundle, not in the CLI.
- Source in `app/src/`; build script `app/build.ts` writes `src/app/assets.generated.ts` (like `orca-plugin/build.ts` writes `src/plugin/assets.generated.ts`): `APP_FILES: {path, type, text}[]`. `bun build --compile` inlines it, so the binary serves the app with no files on disk. The release build refuses a stale generated file, as it does for the plugin.
- Design system: `app/src/ds/` holds `tokens.css` (generated from the design system's `tokens.json`), the component styles, and TSX versions of `Button`, `Pill`, `UsageMeter`, `Card` and `Mark` with the same props as `window.Pacer`. Light and dark follow the system.
- Routing: hash routes (`#/sessions/<id>`), so reloads and back/forward work with one static `index.html`.
- Data:
  - `GET /v2/snapshot` on load, then `GET /v2/events` (EventSource, resumes with `Last-Event-ID`); a `reset` event or a reconnect triggers a fresh snapshot.
  - Screen data that is not in the snapshot (accounts, runners, config, strategy, hosts, setup, updates) is fetched with ops and refetched when a related event arrives or after the screen's own mutation.
  - Task logs stream from `GET /v2/tasks/<id>/log?follow=1`.
- State never lives only in the page: a reload shows the same thing. Unsent form input is kept in `sessionStorage` per screen.
- View models are pure functions in `app/src/model/` (unit-tested with `bun test`); components only render them.

### Browser access

Today every route except `/health` needs `Authorization: Bearer <token>`. A browser cannot send that header to a page it navigates to, so the app gets a cookie session, guarded against other sites and DNS rebinding:

1. **`pacer open [--print] [<screen>]`** makes a one-time code (32 random bytes, hex), stores its SHA-256 in `PACER_HOME/app/codes.json` (0600) with a 60 s expiry, and opens `http://127.0.0.1:<port>/app/auth?code=<code>#/<screen>` with `open` (macOS) or `xdg-open` (Linux); `--print` prints the URL instead. If the daemon is not running, it says so and prints `pacer service install` (it does not start a foreground server).
2. **`GET /app/auth?code=`** checks and deletes the code, creates a session (32 random bytes; SHA-256 stored in `PACER_HOME/app/sessions.json`, 0600, 30 days, refreshed on use), sets `pacer_session=<value>; HttpOnly; SameSite=Strict; Path=/`, and redirects 303 to `/app/` (keeping the fragment). An invalid or used code gets a page that says to run `pacer open` again.
3. **Every request** (all routes, `/health` included) must carry `Host: 127.0.0.1:<port>` or `localhost:<port>`; anything else gets 421. This stops DNS rebinding.
4. **Cookie-authenticated requests**:
   - are accepted on `/app/*` and `/v2/*` only;
   - for any method other than GET/HEAD, require `Origin` equal to `http://127.0.0.1:<port>` or `http://localhost:<port>` **and** the header `X-Pacer-Client: app` (a custom header cannot be sent cross-site without CORS preflight, and pacer answers no preflight);
   - reject `Sec-Fetch-Site` values other than `same-origin` or `none` when the header is present.
5. **Bearer auth** keeps working unchanged for CLI, dashboard, plugin and other clients; the token comparison becomes constant-time.
6. **No CORS**: no `Access-Control-*` headers, `OPTIONS` gets 405.
7. **Headers on `/app/*`**: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` for `index.html` and the auth page.
8. **`pacer open --logout`** (and Settings › Sign out) deletes all sessions.

The Orca panel's **pacer: Open** command keeps pointing to the app; once `pacer open` exists, its notification says "Run `pacer open`" instead of `pacer dashboard`. (Opening an Orca browser tab from the plugin needs a host API Orca does not have; not in scope.)

### New v2 operations

All additive (protocol stays 2.x, `docs/protocol.md` regenerated). Each validates with zod in `src/api/ops.ts` and calls a core function; CLI commands that do the same thing are refactored onto that core function so behaviour is identical. Every mutation publishes a `config` event (new, additive) `{area: "config"|"accounts"|"runners"|"routing"|"strategy"|"hosts"|"setup"|"update", at}` so every client refreshes.

| Op | Params | Result | Notes |
|---|---|---|---|
| `config.get` | `{}` | `{keys: {<key>: {value, source}}, planners: string[]}` | the `CONFIG_KEYS` allow-list; `planners` = runner ids that can plan |
| `config.set` | `{key, value, integrations?: "install"\|"skip"}` | `{key, value, previous, diff, undo}` | same validation and rollback as `pacer config set`; `planner` requires `integrations` (see Consent) |
| `notifications.get` / `notifications.set` | `{}` / `{level: off\|important\|all}` | `{level}` | wraps `pacer plugin set notifications` |
| `account.list` | `{}` | `AccountRow[]` | as `pacer account list --json`; never emails; `signin_command` for claude/codex accounts that are not signed in |
| `account.add` | `{kind: claude\|codex, name, home?}` | `{account: AccountRow}` | creates the folder; never spawns a login; endpoint accounts come with the endpoint ops |
| `account.remove` | `{name, delete_home?: boolean}` | `{removed: true}` | refuses while a runner uses it; protected-path checks as the CLI |
| `runner.add` | `{agent, account?, host?, model?}` | `{id}` | appends to the default routing rule, as `pacer runner add` |
| `runner.remove` | `{id}` | `{removed: true}` | updates routing and `pacing.order` |
| `routing.get` | `{}` | `{rules: [{kinds?: string[], executors: string[]}], available: string[]}` | |
| `routing.set` | `{rules}` | `{diff}` | validated like the strategy file; the default rule must stay last |
| `agent.preview` | `{agent}` | `{agent, files: string[], undo}` | the consent preview `pacer init` shows |
| `agent.connect` | `{agent, consent: true}` | `{installed: string[]}` | refuses without `consent: true` |
| `agent.disconnect` | `{agent}` | `{removed: string[]}` | as `pacer uninstall <agent>` |
| `setup.check` | `{}` | `SetupChecklist` | |
| `setup.init` | `{planner}` | `{strategy: path}` | creates `strategy.yaml` if missing and sets the planner; never touches agent configs |
| `service.status` | `{}` | `{installed, running, pid?}` | |
| `plugin.install` | `{}` | `{path}` | writes `PACER_HOME/orca-plugin` only; never edits Orca's settings |
| `update.check` | `{force?: boolean}` | `checkUpdateReport` | |
| `update.apply` | `{}` | `{started: true}` | runs `pacer update` in a child process; progress and the outcome arrive as `alert` events; the daemon restarts at the end and the app reconnects |
| `strategy.show` | `{name}` | `{yaml, summary, active}` | |
| `strategy.preview` | `{draft}` | strategy service `preview` | |
| `strategy.save` | `{name, draft, reason, overwrite?}` | `{name, path}` | |
| `strategy.remove` | `{name}` | `{removed: true}` | `default` and the active strategy are refused |
| `host.add` | `{alias, ssh}` | `{alias}` | |
| `host.remove` | `{alias}` | `{removed: true}` | refuses while a runner uses it |
| `version.get` | `{}` | `{pacer, protocol, plugin?, service}` | |

Ops that need a terminal stay out of the app in this version: `strategy build` (opens an agent session) and account sign-in. The app shows the exact command with a copy button and refreshes when the account reports signed in.

### Consent

Some actions write into agent configuration (`~/.claude`, `~/.codex`, `~/.cursor`, `~/.config/opencode`): connecting an agent, and changing the planner (which installs the new planner's integration and removes the old one's).

- The app always shows `agent.preview` first: the agent, every file that will change, and the undo command. The user confirms with a button that names the action ("Connect Codex").
- `agent.connect` refuses without `consent: true`; `config.set planner` refuses without an explicit `integrations` value. "Skip" changes the planner and leaves agent files alone, with a note that hooks and the status line stay on the old planner until connected.
- Tests use temp HOME and PACER_HOME only.

## Errors and empty states

- Every op error shows its `message` and `hint` next to the control that caused it, never as a generic toast.
- Lost connection: a bar says "pacer isn't responding. Retrying…" and the page keeps its content; on reconnect it refreshes. 401: a page that says "Session ended. Run `pacer open`."
- Empty states say what to do next ("No tasks yet. Delegate one, or ask your planner to.").

## Testing

- **Unit** (`bun test`): browser access (Host, Origin, Sec-Fetch-Site, custom header, cookie, code expiry and single use, session expiry, constant-time compare, CSP headers, no CORS), every new op (happy path, validation, refusal cases, `config` events), the asset build (generated file matches a fresh build), and the app's view models.
- **Server integration**: `startServer` on port 0 with a temp PACER_HOME serves `/app/`, completes the `pacer open` code exchange with real `fetch` and cookies, and calls ops with the cookie.
- **Real UX**, before the app PR is called done, in a real browser against a daemon with an isolated PACER_HOME and on the owner's real setup:
  first run; add an executor and delegate to it; review a task from the log and diff; change the planner (consent shown); block and unblock; stay on a page for an hour; update. Each journey is recorded for the owner. A clean macOS account run follows before release.

## Delivery

1. **App API and browser access** (this branch): the ops above, `config` events, cookie sessions, Host/Origin checks, `pacer open`, `/app/` serving a placeholder page.
2. **Endpoint executors** ([spec](2026-10-15-endpoint-executors-design.md)): `account.add` for endpoints, key stores, model discovery, generated OpenCode config, `account.test`.
3. **The app**: Preact screens on the design system, embedded in the binary.

Each is its own PR, stacked in this order.

## Not in this version

- A packaged desktop app (the same bundle, wrapped later).
- Remote access to the app from another machine (loopback only).
- Multi-user: one OS user, one daemon, one set of sessions.
- Strategy build with an agent from the app; account sign-in inside the app.
