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
`#/sessions/<id>` and `#/setup`; bookmarks require an active browser session. Old app routes
(`#/tasks`, `#/tasks/<id>`,
`#/executors`, `#/executors/add`, `#/accounts`, `#/strategy` and `#/hosts`) no longer redirect to their replacement screens. They fall back to
Overview (`#/`), as do other unknown or malformed hashes. Incomplete setup
redirects work screens to Setup; Settings stays reachable.

`pacer open --print` prints a sign-in URL instead of opening the browser.
Open it within 60 seconds; it works once. Treat it as a credential and do not
share it. Run `pacer open` again if it expires or has already been used.

`pacer open --logout` signs out all browser sessions. Settings also shows this
command under Sign out; run it in a terminal.

## Screens

| Screen | What you can do |
| --- | --- |
| Setup | Complete required steps, connect agents with a file preview and consent, add an executor, try or skip a first delegation. |
| Overview | Check planner usage and pace, mode, items needing attention, who runs next and running work; delegate a task. |
| Tasks | Browse running tasks, tasks waiting for review and paginated history; delegate, stop, retry or dismiss work. |
| Task detail | Follow the live log, inspect the diff and untracked files, accept or reject with a note, retry or stop. |
| Executors | Inspect availability and reasons, reorder and save routing, block or unblock, test endpoints and remove executors. |
| Add executor | Choose an agent and account; for a model endpoint, enter connection details, discover models and test. Endpoint Ready state requires a passing test. After success, **OK** clears setup and returns to Executors; **Add another executor** resets all choices and starts at agent selection. |
| Accounts & budgets | Inspect usage windows, resets, freshness, sign-in state and endpoint details; add or remove accounts. |
| Strategy | Switch strategies, edit pacing, preview the ranking, save a named strategy or remove an inactive non-default strategy. |
| Hosts | Add, check and remove remote hosts. |
| Settings | Change the planner, notifications and integrations; check and apply updates, inspect versions and find the sign-out command. |

Headless runs in the Session view show “This run is headless — Take over to work
in it live” with a prominent **Take over** button. Watch-elsewhere options and the
attach command appear only for live or recorded terminal sessions.

Account sign-in still happens in a terminal: the app shows the command to copy
and refreshes the sign-in state. Setup explains the login service inline; **Install service** confirms that consent. Connecting an agent, or changing the planner with integrations, shows
the affected files and undo command before asking you to confirm.

The app refreshes from live events. If the daemon disconnects, it keeps the
current page content and shows “pacer isn't responding. Retrying…”. It refreshes
when the connection returns. Unsent form drafts are kept in the tab's
`sessionStorage`; endpoint keys are not retained there.

## Guided setup

Setup shows five steps in a left rail: choose a planner, install the background
service, connect the planner, choose executor priority, and try an optional first
task. Only the current step appears in the right panel. Actions refresh the
checklist and advance in place; the Setup route stays open. **Change** returns to
planner selection without connecting integrations until the connection step.

The connection card explains additions and edits in plain words. **Show the files**
reveals technical paths and the undo command before consent. **Skip for now** leaves
connection pending, with a return action in the rail. Restart open planner sessions
after connecting. Executor checkboxes enable or block work, and arrow buttons save
priority. **Looks right** confirms the list; an empty list offers the existing
terminal add-executor flow while keeping Setup open.

The first task shows its chosen executor, progress, diff, and **Accept and finish**
or **Reject** inline. **Skip for now** records that the optional exercise was skipped.
Provider sign-in commands remain in a disclosure with a copy action. Errors appear
under the current action. Until pacer is ready, Home offers **Continue setup**;
banner dismissal lasts until the pending recommended items change.

## Needs you and Tasks

On wide screens, Overview pairs Needs you with Capacity, Running with Quick delegate,
and Done today with Activity. Cards in each row share their height. Needs you and
Capacity show five rows per page; Running, Done today and Activity show three.
Previous/Next navigation keeps longer lists contained. Repository changes reset
scoped lists to their first page. Compact Capacity continues to show all executors.
Narrow layouts stack the existing sections. The standalone Needs you page retains
its full actionable queue.

**Needs you** contains actionable questions, failures, incomplete work and explicit
human review requests, alongside existing account, setup and service problems.
Items follow the service order: blocked items, problems, then decisions, oldest
first within each group. Repository filters narrow work, not shared budgets.
Dismissed and snoozed items stay hidden. Web, tray and TUI use the same reasons
and counts. Ordinary completed runs never escalate merely because no verdict
was recorded, including planner-delegated work after ten minutes.

**Tasks** contains running work and paginated execution history. Open a finished
run to see its result, checks, changes and delivery information before the
collapsed executor transcript. Execution status and quality verdict are separate:
a run can be Completed with Outcome not recorded. Accepted does not mean merged;
Pacer shows Integration not recorded unless integration is independently known.
Existing verdicts do not identify the reviewer, so they are labelled Accepted.

Planners should record a verdict after actually reviewing a result. When a human
decision is needed instead, use `pacer task request-review <id> --note "<concern>"`
or MCP `task_request_review`. The note explains the specific decision. Explicit
requests offer **Mark accepted**, **Send back**, and **Reject result** in detail.
Failed checks and incomplete results expose recovery actions. Ordinary completed
runs keep verdict recording optional. Mixed attention has no bulk accept action.

Acceptance records a verdict only; integrate branches separately. Send back needs
a note and creates a linked retry on the same executor. Retry on another executor
also creates a linked attempt. Concurrent mutations report a conflict and refresh
the result rather than overwriting another client's decision.

Historical unreviewed completions remain in Tasks without fabricated verdicts or
dismissals. Their retention eligibility is unchanged. Legacy review/session links
open the corresponding Needs you or task destination. Older services cannot create
explicit requests; missing-verdict reviews for known ordinary completions are
suppressed conservatively while failures and other actionable items remain.

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


`pacer status --line` adds `▸<running> ⚑<attention>` from the service counts.
It waits up to 300 ms, then uses local budget data without counts. When the
service is unavailable and the stored snapshot is over 120 seconds old, it
prints `pacer not running · pacer serve`.

The **Delegate** dialog starts with the active repository filter, an unfinished draft’s repository, or the last repository successfully used in the dialog. It remembers the last used repository across app restarts. Choose an optional **Kind** to guide routing; the preview updates with the goal, repository and kind and shows the next executor. Submit with **Cmd+Enter** (or **Ctrl+Enter**).
