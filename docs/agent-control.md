# Agent control of Pacer

The CLI is the primary agent interface. The installed Pacer skill teaches discovery
and workflow; it does not embed the operation catalog. MCP remains optional.

## Discover, inspect, invoke

```sh
pacer api list --prefix runner. --json
pacer api list --search settings --json
pacer api describe runner.settings.save --json
pacer api call runner.settings.get --json
pacer api call runner.settings.save --params-file settings.json --json
```

`list` returns sorted names/descriptions without schemas. Prefix and
case-insensitive name/description search combine. `describe` returns one JSON
input schema from the selected service. Semantic constraints still run when the
operation is invoked. An older service without discovery needs upgrading; the CLI
never substitutes a local catalog for a connected service's schemas.

`call` accepts a JSON object with `--params-file <path|->`, or `--params <json>`
for small objects. Omitted parameters mean `{}`. Files/stdin avoid shell quoting
and keep keys out of command arguments. Inputs are limited to 256 KiB. JSON mode
never prompts. Success writes `{ "result": ... }` to stdout; errors write
`{ "error": { "code", "message", "hint"? } }` to stderr with empty stdout.
Input/unknown-operation errors exit 2; execution/transport failures exit 1.

Use the same observed revision and consent fields as the app. A conflict means
re-read before deciding; a lost mutation response is an unknown outcome and must
not be blindly replayed. Discovery does not grant permission to change anything.
Executor sessions cannot launch onward work through generic calls.

Calls use v3. Without a service, locally supported operations may run in process.
An explicit `PACER_PORT` requires that service; failures/refusals never retry
locally. Sessions, attachments, connected page controls and desktop updates need
a running service and their relevant workers. `api --stdio` keeps its v2 default
and supports explicit v3 negotiation; see [the protocol](protocol.md).

## Sessions and files

`pacer session start --json --attach diagram.png -- <request>` starts a conversation.
Use `pacer session end <id> --json` and `resume <id> --json` for lifecycle changes.

`pacer session io <id> --control --json` maintains one authenticated WebSocket
viewer. Send newline-delimited JSON on stdin and consume NDJSON on stdout:

```json
{"type":"input","text":"Explain this change\r"}
{"type":"size","cols":120,"rows":40}
{"type":"release"}
{"type":"take"}
{"type":"detach"}
```

Input requires acknowledged control. Another controller produces a conflict;
`--force` explicitly requests takeover with `--control`. Input may instead use
`base64` to preserve bytes. Output frames carry `base64`; other frames retain the
public session protocol fields and `task_id`. Snapshot/output/resync frames define
the same replay contract as the app; reconnect with `--from <outputOffset>` from
a snapshot, or omit it to obtain a fresh snapshot. Default timeout is 600 seconds,
range 1–3000. Timeout/disconnect exits nonzero and does not stop the session.
EOF on stdin leaves observation active until exit, detach or timeout. Do not close
the process merely to send another prompt: control belongs to the connection.
`watch` and `wait` remain convenient for delegated task observation.

For initial or later files:

```sh
pacer api call session.draft.create --json
pacer attachment upload --draft <draft-id> --file diagram.png --json
pacer attachment list --draft <draft-id> --json
pacer attachment download --draft <draft-id> --id <attachment-id> --out diagram-copy.png --json
pacer attachment remove --draft <draft-id> --id <attachment-id> --json
pacer api describe session.attachment.prepare --json
```

Use the draft from `session.context` for an existing conversation. Upload limits,
ownership and deletion protection match the app (25 MiB per file, 100 MiB per
session). Downloads create private files and never replace an existing file.
For later delivery, prepare the attachment and send its returned reference through
the controlled session when requested. Preparation alone does not submit input.
External agent/OS login flows still require their owner to authenticate; Pacer
can start the flow and report status without reading native credentials.

## Client-local actions

Discover `client.control.*`, list targets, then request an action using the exact
`client_id`. Each target identifies an app/desktop page and main/tray window.
Worker credentials stay private to that page; agents use request/result only.

```json
{"client_id":"<target>","action":{"type":"theme.set","value":"dark"}}
```

Actions are `theme.get`, `theme.set` (system/light/dark), `navigate` with an app
route, `window` (show/minimize/toggle-maximize/close), `tray` (show/hide),
`launch-at-login` with `enabled`, and `quit`. Native actions need a desktop target.
Appearance stays on the selected device/origin; it is not an account-wide setting.
Navigation requires a main-page target, respects unsaved-form confirmation and may fail as cancelled. Tray links have the equivalent `pacer open <screen>` launcher.

Poll `client.control.result` with the returned `request_id`. Pending/claimed is
not success. A complete result means the worker applied the action. Expiry,
disconnect or unsupported commands fail; quit may terminate the worker before
acknowledgment, leaving an unknown outcome. Do not retry blindly. Worker leases
last 60 seconds; action deadlines are 30 seconds. A second outstanding action on
the same client conflicts. `pacer open <screen>` remains the launcher when no
page is connected. Window close follows the desktop's hide-to-tray behavior.

## Surface coverage matrix

This matrix describes intended command coverage, not a claim that every real
side effect has been live-validated. The implementation evidence report records
PASS/FAIL/UNVERIFIED for exercised behaviors; guarded installations, logins and
remote effects remain UNVERIFIED until exercised under the required approvals.
All registry operations have discoverable input schemas; inspect before calling.

| User capability | Desktop/TUI source | Agent interface | Prerequisite and result observation |
| --- | --- | --- | --- |
| Overview, budgets, pace, counts, attention, activity | app Overview/tray; TUI Home | `snapshot.get`, `routing.status`, `activity.list` | Snapshot sequence; same public state |
| Search/filter/paginate repositories and sessions | app Overview/Sessions/Review; TUI screens | `repo.list`, `task.list` | Structured fields and cursor; filter returned rows for client-only searches |
| Task details, brief, outcomes and changes | app TaskResult; TUI detail | `task.get`, `task.diff`, `task.log` | Task ID; same public detail/patch/byte offsets |
| Snooze/dismiss attention | app/tray/TUI attention | `attention.snooze`, `attention.dismiss` | Current attention ID; new snapshot |
| Delegate and observe | app Delegate; TUI new work | `task.delegate`; `delegate`, `watch`, `wait` | Budget/role; task state, output, acceptance |
| Session start/end/resume/context | app StartSession/Conversation; TUI Sessions | `session.*`; `session start/end/resume` | Service, repo/executor; task ID/context/revision |
| Session view/replay/input/control/resize | app Terminal; TUI attach | `session io`, `attach`; `task.session` | Live service; stream/controller/replay snapshots; explicit takeover |
| Session attachments, paste/upload/download/remove/use | app attachments/composer | `attachment`; `session.attachment.prepare` | Draft/task ownership; metadata/reference and subsequent stream |
| Answer a question; retry or retry all | app/tray/TUI task actions | `task.answer`, `task.retry`, `task.retry_all`, `task.retry_options` | Fresh task revision/state; retry result |
| Review/accept/reject/send back/request human review | app/tray/TUI review | `task.review`, `task.request_review` | Review diff/acceptance first; resulting task/retry |
| Stop, dismiss, archive, restore, clean worktrees | app/TUI sessions | `task.stop/dismiss/prune/restore`; `clean` | Current task; operation result; clean dry-run before removal |
| Take over/open session in terminal | app Conversation; TUI detail | `task.takeover`, `task.attach`; `takeover`, `attach` | Executor/session capability and terminal prerequisite |
| Pause/resume, hold/release mode | app/tray/native menu; TUI | `delegation.pause/resume`, `mode.hold/release` | New snapshot/expiry; running work continues |
| Setup and first task | app Setup; TUI Setup | `setup.check/init`, `onboarding.try/skip` | Consent where offered; checklist/task result |
| Connect/disconnect planner; repair integrations | app Setup/Diagnostics; TUI setup | `agent.detect/preview/connect/disconnect`, `doctor.run`; `install/uninstall` | User authorization, preview revision; diagnostic recheck |
| Service install/status/remove and bootstrap recovery | desktop first-run/recovery; TUI setup | `service install/status/uninstall`, `setup`; installer/update commands | Real environment authorization; health/setup checks; OS prompts remain user-owned |
| Accounts add/edit/adopt/models/test/sign-in/remove | app Accounts/AddExecutor; TUI Accounts | `account.*`, `executor.setup.*`; account CLI | New keys supplied by reference/file/stdin; readiness/job/status |
| Runner add/remove/order/block/settings | app Executors/setup; TUI Executors | `runner.*` | Revision when offered; settings/readiness/snapshot |
| Routing, global/project executor policies | app Routing/Projects; TUI Settings | `routing.get/set/route`, `project.strategy.*` | Repo identity, revisions; ranking/eligibility |
| Strategies list/show/preview/save/use/remove/build | app Strategies; TUI Strategies | `strategy.*` | Preview and user-requested save/switch; selected/ranking/job or session |
| Configuration, terminal target and planner reserve | app General; TUI General | `config.get/set` | Valid key/value; undo and snapshot; planner integration choice |
| Notifications | app Settings; TUI Notifications | `notifications.get/set` | Same level/source; re-read |
| Diagnostics and repairs | app Diagnostics; TUI setup | `doctor.run`, discovered action operations | Read checks, preview repair, invoke authorized operation, recheck |
| Host details/config/check/accounts/repo mapping/setup/clean/terminal/remove | app Hosts; TUI host actions | `host.*`; host CLI | SSH/identity/consent and remote approval; job/facts/status |
| Plugins install/enable/disable/remove/diagnose | app Plugins; TUI diagnostics | `plugin.*`; plugin CLI | Capability grant consent; plugin state/doctor |
| CLI/service update check/apply and jobs | app/TUI Updates | `update.check/apply`, `job.get/list/cancel`; `update` | Installed format; job result/version |
| Desktop update configure/check/download/restart/cancel/adopt | app/TUI/native update notice | `desktop.update.*`; `desktop-update` | Verified connected installation, observed revision/version, request ID; update status |
| Appearance and open a screen | app Appearance; tray links/native Open | `client.control.request` theme/navigation; `open <screen>` | Target page; acknowledged result; per-device storage |
| Native main-window and tray controls, quit | desktop titlebar/menu/tray | `client.control.request` window/tray/quit | Connected native target; acknowledgment or honest unknown outcome |
| Native launch at login | native preference command | `client.control.request` launch-at-login | Native/OS support; acknowledgment or required OS approval |
| TUI appearance/colors/motion/glyphs | TUI Appearance | `PACER_THEME`, `PACER_COLOR`, `PACER_NO_ANIM`, `PACER_ASCII` when launching `dashboard` | Per-terminal environment; `dashboard --once --screen settings` to inspect/render |
| TUI navigation/help/refresh/quit | TUI shell | Query same data via `snapshot.get`/operations; `dashboard --once --screen ...`; stop owned process | No remote keystroke recreation required |

## Validation boundary

The live harness D3/D8 guards apply to generic calls, including their service
selection. Do not call the private upstream port, force local execution, or disable
guards to make an installation/login/update appear validated. Safe fixtures test
surrounding behavior; blocked real effects must remain explicitly UNVERIFIED.
