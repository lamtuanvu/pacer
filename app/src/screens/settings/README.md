# U3 settings screens

Import `screens/settings/index` explicitly. This barrel exports the U3 screens mounted by the shell. Every settings route loads through `LazySettings`, so none of these screens counts toward `app.js`.

| Route | Component |
| --- | --- |
| `#/settings` | `SettingsGeneral` (Overview) |
| `#/settings/<section>` | `SettingsGeneral section={section}` (only the selected editor mounts) |
| `#/settings/dispatcher` | Dispatcher › Overview: model choice, preview and Native subagent control (`DispatcherSection tab="overview"`, lazy) |
| `#/settings/agents` | Dispatcher › Agents (`AgentsTab`, lazy through `LazyAgents`); `?agent=<runner id>` selects an agent |
| `#/settings/rules` | Dispatcher › Who can run what: guided rules and draft preview (`DispatcherSection tab="rules"`) |
| `#/settings/profiles` | Dispatcher › Profiles: saved setups (`DispatcherSection tab="profiles"`) |
| `#/settings/executors`, `#/settings/accounts`, `#/settings/models` | Redirect to `#/settings/agents` (keeping `agent`, `repo`, `scope`) |
| `#/settings/add-executor` | Add agent wizard (`AddExecutor`); `?host=<alias>` prefills the host |
| `#/settings/machine` | Machines: This machine, guided Add remote host (`AddHost`), host list |
| `#/settings/hosts` | Machines (same page) |
| `#/settings/hosts/<alias>` | `HostDetail alias={alias}` |

The Dispatcher tabs and Add agent are part of the Dispatcher menu entry, host detail of Machines (`settingsNavId` maps them). The screens register their token-based constructed stylesheet on mount; the shared build and stylesheet need no edits. `initialData` is optional preloaded data for rendering before requests complete. The API remains authoritative after mounting.

Jobs use store events plus `job.get` polling. Host detail also recovers retained jobs with `job.list`. The Add agent draft preserves the service-returned id and job id across reloads. Host detail shows the Full live sessions switch only when `host.get` returns a `session` field; it sends `host.set` with `session: 'full' | 'recording'`.

Settings category metadata lives in `app/src/settings-pages.ts`; board pages own their h1 and caption. Every Dispatcher tab shares one page head (`DispatcherHead`: the h1 and `NavTabs`, with the Agents tab's unrated count from `dispatch.models`). Machines and Add an agent use the shared board header; host detail keeps its breadcrumb without an h1. Settings forms use DS `settings` density (32px) and small table actions use 28px; narrow layouts retain touch targets.

Dispatcher › Agents (`Agents.tsx`) is master-detail. The agent list fills the shell's right panel (`FrameSlot name="right"`, opened once on arrival) or renders in page when panels cannot show; entries are links to `?agent=`, so choosing another agent keeps the page and its draft mounted (the navigation guard lets `#/settings/agents` targets through). The detail shows readiness (with Unblock for a blocked agent), Usage (`AccountUsage` for Check usage), Account (`AgentAccount`: sign-in state and fix, the agent's other accounts, the spread/fill policy when it has several, adding an account), Runs on (host link, Run test task), the planner's tier fallback switch (`pacing.planner_tier_fallback`, immediate), the Models table and Add a model (`AgentModels`), and limits. Models (`useModelDrafts`, `runner.models.set_many`) and limits (`useExecutorSettings`, `runner.settings.save`) form one page draft and one `SaveBar`, hidden while idle; the models save first and the limits save against the revision it returned. Takes work saves immediately from the latest saved revision and keeps the draft; its switch is busy during the write and reverts with an inline error on failure. Conflicts preserve drafts: limits show Reload saved settings, models ask to Discard unless the reloaded models are identical (then the newer revision is adopted, and a save that meets a moved revision with unchanged models retries once). Removal asks first, keeps task history and focuses Add agent. No new service operations.

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
