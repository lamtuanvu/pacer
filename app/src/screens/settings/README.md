# U3 settings screens

Import `screens/settings/index` explicitly. This barrel exports the U3 screens mounted by the shell. Every settings route loads through `LazySettings`, so none of these screens counts toward `app.js`.

| Route | Component |
| --- | --- |
| `#/settings` | `SettingsGeneral` (Overview) |
| `#/settings/<section>` | `SettingsGeneral section={section}` (only the selected editor mounts) |
| `#/settings/executors` | Agents, Executors tab (`ExecutorsSection`) |
| `#/settings/accounts` | Agents, Accounts tab (`AccountsSection`) |
| `#/settings/add-executor` | Add agent wizard (`AddExecutor`); `?host=<alias>` prefills the host |
| `#/settings/machine` | Machines: This machine, guided Add remote host (`AddHost`), host list |
| `#/settings/hosts` | Machines (same page) |
| `#/settings/hosts/<alias>` | `HostDetail alias={alias}` |

The Accounts tab, Add agent and host detail are part of the Agents and Machines menu entries (`settingsPageId` maps them). The screens register their token-based constructed stylesheet on mount; the shared build and stylesheet need no edits. `initialData` is optional preloaded data for rendering before requests complete. The API remains authoritative after mounting.

Jobs use store events plus `job.get` polling. Host detail also recovers retained jobs with `job.list`. The Add agent draft preserves the service-returned id and job id across reloads. Host detail shows the Full live sessions switch only when `host.get` returns a `session` field; it sends `host.set` with `session: 'full' | 'recording'`.

Settings category metadata lives in `app/src/settings-pages.ts`; board pages own their h1 and caption. Agents (both tabs), Machines and Add an agent use the shared board header with 18px block gaps; host detail keeps its breadcrumb without an h1. Settings forms use DS `settings` density (32px) and small table actions use 28px; narrow layouts retain touch targets.

The planner card appears only on Executors. Both tabs use bordered board-density
tables; Accounts adds a sign-in column and a factual information banner. Account
spread/fill controls bind to `pacing.accounts` and `pacing.fill_threshold` through
`config.get`/`config.set`. Executor parallel limits are counts in the table and
editable in Details, joining the existing page draft. The save bar is hidden at
all widths while idle. Takes work saves immediately from the latest saved revision, independently of priority
and parallel-task drafts; its switch is busy during the write and reverts with an
inline error on failure. Conflicts reload saved data and preserve page drafts.
Escape and Close return focus to the opening Details button; successful removal
focuses Add agent. Details retain readiness, account/model/host facts, a test
task and removal; removal changes configuration and keeps task history.

Machines uses two equal bordered cards with a 20px gap and a narrow single-column
layout. Header tiles, service version, running capacity and executor caps use
snapshot facts; OS/architecture, worktree path and SSH HostName captions are not
invented. The host check list and repository/agent next steps appear only after
actual job results. Failed checks offer Check again and a scoped Manage alias link
to host detail, where the host can be removed. The four local rows use board
SettingRows (300px / 1fr, 24px gap, 14px vertical padding). A body container
query stacks these rows below 700px card width with the shared 8px narrow gap.

Add agent keeps the Agents breadcrumb, 230px progress column and polite step
panel. Agent cards expose reported detection and install guidance; a missing
selected agent offers Check again, reloading agent.detect with a busy button; account and
location choices use native radio rows. The model picker offers Agent default
plus models reported by the selected account, retaining an existing draft model.
Test status, live check rows and Run/Retry live inside the Test task block.
Recovery and session draft retention remain in the footer. No new routes or
service operations are introduced.
