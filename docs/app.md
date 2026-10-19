# The pacer app

The pacer app is a browser interface for budgets, delegated work and configuration.
It is served by `pacer serve` at `http://127.0.0.1:4317/app/`, with its files
embedded in the pacer binary. It uses the same [2.x compatibility API](protocol-v2.md) as other
pacer clients. Protocol [3.0](protocol.md) is current; `/v2` remains available for one pacer minor release. The app consumes the read model during this overlap.

## Open the app

With the background service installed and running:

```sh
pacer open
```

When Orca is running, the app opens in an Orca browser tab; otherwise it opens
in your default browser. `pacer open --browser` always uses the default browser.
A browser that was not opened by `pacer open` has no session and shows
"Session ended"; run `pacer open` again to sign it in.

If you have not installed the service, run `pacer service install` first.
Alternatively, keep `pacer serve` running in a terminal. `pacer open` requires
a running daemon; it does not start one.

To open a particular screen, use, for example, `pacer open sessions` or
`pacer open settings`. Pages use bookmarkable hash routes such as `#/`,
`#/review`, `#/review/<id>` for tasks waiting for review, `#/sessions` and
`#/sessions/<id>`; bookmarks require an active browser session. Old app routes
(`#/tasks`, `#/tasks/<id>`,
`#/executors`, `#/executors/add`, `#/accounts`, `#/strategy`, `#/hosts` and
`#/setup`) no longer redirect to their replacement screens. They fall back to
Overview (`#/`), as do other unknown or malformed hashes. Incomplete setup
redirects work screens to Settings.

`pacer open --print` prints a sign-in URL instead of opening the browser.
Open it within 60 seconds; it works once. Treat it as a credential and do not
share it. Run `pacer open` again if it expires or has already been used.

`pacer open --logout` signs out all browser sessions. Settings also shows this
command under Sign out; run it in a terminal.

## Screens

| Screen | What you can do |
| --- | --- |
| Overview | Check planner usage and pace, mode, items needing attention, who runs next and running work; delegate a task. |
| Tasks | Browse running tasks, tasks waiting for review and paginated history; delegate, stop, retry or dismiss work. |
| Task detail | Follow the live log, inspect the diff and untracked files, accept or reject with a note, retry or stop. |
| Executors | Inspect availability and reasons, reorder and save routing, block or unblock, test endpoints and remove executors. |
| Add executor | Choose an agent and account; for a model endpoint, enter connection details, discover models and test. Endpoint Ready state requires a passing test. |
| Accounts & budgets | Inspect usage windows, resets, freshness, sign-in state and endpoint details; add or remove accounts. |
| Strategy | Switch strategies, edit pacing, preview the ranking, save a named strategy or remove an inactive non-default strategy. |
| Hosts | Add, check and remove remote hosts. |
| Settings | Change the planner, notifications and integrations; check and apply updates, inspect versions and find the sign-out command. |

Account sign-in still happens in a terminal: the app shows the command to copy
and refreshes the sign-in state. Service installation also uses a terminal
command. Connecting an agent, or changing the planner with integrations, shows
the affected files and undo command before asking you to confirm.

The app refreshes from live events. If the daemon disconnects, it keeps the
current page content and shows “pacer isn't responding. Retrying…”. It refreshes
when the connection returns. Unsent form drafts are kept in the tab's
`sessionStorage`; endpoint keys are not retained there.

## Needs you and review

Overview reads the service's attention queue in its supplied order: blocked items,
problems, then decisions, oldest first within each group. The service includes
review work, failed or limited tasks, stuck work, sign-in and executor problems,
exhausted planner quota, setup and updates. Ahead-of-pace advice stays on the
planner strip and tray header and does not add to Needs you or its counts.
Dismissed and snoozed items stay hidden as managed by the service. Counts and
the review tab use the same snapshot.
Planner-delegated work enters the review queue after ten minutes without a
verdict; other work enters immediately. Older services retain client fallback
behavior.

Overview and Review offer a repository filter and checkboxes to select review tasks.
Use **Accept selected** or **Reject selected** (with a required shared note), or
**Accept all with passing checks** to check the visible queue’s stored acceptance
results. The confirmation lists each eligible task before recording verdicts.
Tasks without passing checks are excluded from accept-all; errors and concurrent
reviews are reported per task. Accepting records a verdict only; merge branches
yourself.

The API supports four review verdicts: accept, reject, send back with feedback
to the same executor, and retry on another executor. Send back requires a note;
retry requires an executor. Both create a linked retry and record a rejected
review on the original. The current task detail screen exposes accept, reject
and retry; API clients can use all four verdicts. Task detail also exposes the
routing explanation, acceptance duration and summary, per-file diffstat, cost
readings when attributable, retry options and activity timeline through the API.

## Security model

The app is local to one OS user and daemon. The server binds to loopback only;
remote browser access is not supported. Requests must use the loopback host and
port. Browser changes also require a matching Origin and an app-specific header;
cross-site requests are refused and CORS is not enabled.

`pacer open` exchanges a short-lived, one-time code for an HttpOnly,
SameSite=Strict cookie session. Sessions last 30 days and are refreshed on use.
Only hashes of codes and sessions are stored, in files with permissions `0600`
under `PACER_HOME/app`. The app uses same-origin assets and a restrictive Content
Security Policy. CLI and other bearer-token clients keep their existing access.

Account responses do not expose account emails, keys or tokens. Endpoint key
fields hide the entered value; keys are submitted to the daemon for storage and
are not saved as form drafts. See the [protocol](protocol.md) for the browser
access checks.

## Troubleshooting

### Session ended

When the app says “Session ended. Run `pacer open`.”, run that command to get a
new sign-in link. An old sign-in URL cannot be reused. If you signed out with
`--logout`, every browser session needs to sign in again.

### Daemon not running

If `pacer open` says “pacer isn't running”, run `pacer service status` to inspect
the service, then `pacer service install` to install or refresh it. For a
foreground session, run `pacer serve` in another terminal and leave it running.
Then retry `pacer open`. It does not start a foreground server automatically.

### Port in use

The default port is 4317. If `pacer serve` cannot bind because it is already in
use, check whether an existing pacer service is running before starting another
daemon. If it is pacer, use `pacer open` with that service.

For a conflict with another application, choose a free port and use it for both
the daemon and the opener:

```sh
PACER_PORT=4318 pacer serve
# In another terminal:
PACER_PORT=4318 pacer open
```

For the background service, install it with the chosen port using
`PACER_PORT=4318 pacer service install`, then use the same `PACER_PORT` with
`pacer open`. Do not run both a foreground daemon and the service on the same
port.

## Client compatibility

Console commands and TUI actions use v2 operations. The TUI hides actions
missing from `hello.ops`. Task sessions use the session API. `/state`,
`/console/*`, `/link` and the unversioned `/events` route are removed.
Internal probes and the app use `/v2/snapshot` during the one-minor overlap.
The Orca plugin uses only the API transport, with HTTP v2 or stdio.


`pacer status --line` adds `▸<running> ⚑<attention>` from the service counts.
It waits up to 300 ms, then uses local budget data without counts. When the
service is unavailable and the stored snapshot is over 120 seconds old, it
prints `pacer not running · pacer serve`.
