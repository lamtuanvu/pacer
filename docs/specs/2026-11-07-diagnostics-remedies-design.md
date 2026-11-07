# Diagnostics remedies: every problem has a fix

Date: 2026-11-07. Status: approved for implementation (@lamtuanvu). Applies to: `doctor.run`, Settings → Diagnostics, the Checking setup gate, the CLI `pacer doctor` output, and the plugin call path under the native process owner. Builds on [startup setup health](2026-11-06-startup-setup-health-design.md). Decision record: [ADR diagnostics remedies](../decisions/2026-11-07-diagnostics-remedies.md).

## Problem

Diagnostics reports problems but rarely fixes them. Only four check names, and only for the selected planner, get a Repair button (`diagnosticRepair`). Budget rows link to Accounts, and every other row prints a CLI string such as `pacer install claude-code` for the user to run by hand. The Checking setup gate maps check names to fixes again on the client (`setupHealthRepairs`).

Some warnings are not about the user's setup at all. Under the native process owner (`PACER_HOST_SOCKET` set), the TypeScript plugin registry refuses to start plugin children (`plugin_unavailable: native process owner supervises plugin children`). Integration freshness, Planner check and budget checks then report that refusal as a user problem and suggest reinstalling the integration, which cannot help.

## Goals

- Every warning or failure carries exactly one primary fix the UI can run with one click.
- The server decides the fix. Clients render it; they never derive an action from check names or fix text.
- Problems pacer cannot fix itself go to an agent as an ordinary pacer task, reviewed like any other.
- Failures caused by pacer itself are labelled as pacer's, never as the user's setup.
- Under the native process owner, plugin-backed checks run through the owner instead of failing.

## Non-goals

- Fixing agent CLIs pacer does not manage without an agent task and the user's review.
- Silent changes to files the user may have edited (agent folders) without a preview.
- Treating exhausted quota as fixable setup (unchanged from the startup spec).

## The fix ladder

The doctor assigns each warning or failure the first rung that applies.

| Rung | `remedy.kind` | When | Button (example) | What happens |
| --- | --- | --- | --- | --- |
| 1 | `auto` | A known fix that changes only pacer's own state or pacer-managed files and can be undone | Refresh usage · Update files · Restart service | Runs at once, then reruns that check. Included in "Fix N issues automatically". |
| 2 | `review` | A known fix that writes into an agent's folder, where user edits may live | Review and fix | `agent.preview` lists each file and its change; apply with consent via `agent.connect`; previous copies are kept for undo. |
| 3 | `user` | Only the person can do it: sign-in, payment, an OS permission | Sign in to Codex · Open BytePlus billing | Opens the exact place (`account.signin`, a URL, a System Settings pane) and rechecks when the client regains focus. |
| 4 | `agent` | The setup is broken and pacer has no built-in fix | Fix with agent | Starts a pacer task carrying the check, its details and the report (see Fix with agent). |
| 5 | `internal` | The check could not run because of pacer itself | Restart pacer service | Shown in a separate "Couldn't check" group with the cause once. Never suggests reinstalling agents. If restarting does not clear it, "Send report to pacer". |

`ok` and `info` checks carry no remedy.

## Data model

`doctor.run` checks gain an optional, additive field:

```ts
interface Remedy {
  kind: "auto" | "review" | "user" | "agent" | "internal";
  label: string;            // button text, a verb and its object
  op?: string;              // an existing registered operation, e.g. "limits.refresh"
  params?: Record<string, unknown>; // validated by that operation's schema at call time
  url?: string;             // kind "user" only: https or x-apple.systempreferences: links
  secondary?: { label: string; op?: string; params?: Record<string, unknown>; url?: string };
}
interface Check { /* existing fields */ remedy?: Remedy }
```

- `fix` (free text) stays for the CLI output and older clients; new clients ignore it when `remedy` is present.
- `op` must name a registered operation; a unit test checks every remedy the doctor can emit against the registry. Consent-gated operations keep their consent step: the client never sends `consent: true` without the user's click on a screen that showed what will change.
- Mapping from today's checks:

| Check | Remedy |
| --- | --- |
| `Usage <id>` stale / unknown | `auto` · `limits.refresh {account}` |
| `Usage <id>` auth error | `user` · `account.signin {name}` |
| `Usage <id>` payment / no plan | `user` · provider billing URL; secondary "Turn off <name>" · `runner.block` |
| `Login <id>` | `user` · `account.signin {name}` |
| `Integration freshness <agent>` state refreshed / stale managed assets | `auto` · `agent.connect` restricted to pacer-managed files (no user-edited file changes; otherwise `review`) |
| `Install <agent>`, `Skill <agent>`, `Claude hook configuration`, `Legacy guard` | `review` · `agent.preview` → `agent.connect {agent}` for any connected agent, not only the selected planner |
| `Service` not installed / not running | `auto` · `service.install {consent}` after the existing confirmation |
| `Binary <id>` missing | `agent` |
| `CLI <id>` help fails | `agent` |
| Any check whose error code is `plugin_unavailable`, `plugin_timeout` raised by pacer, or another pacer-internal code | `internal` |
| Anything else that warns or fails | `agent` |

## Fix with agent

- New operation `doctor.fix.delegate {check, scope: "fix" | "investigate"}`. The server re-reads the latest doctor result for that check (never trusts client text), builds the brief and calls the existing delegation path (`task.delegate`), so routing, pacing and review apply as usual.
- A fix task has no user repository. `task.delegate` requires `repo`, so the task runs in a pacer-owned scratch folder under `$PACER_HOME` (one per fix task, created empty, never a user repository); the agent reaches the failing tool through its normal environment, within the scope below.
- The brief contains: goal ("make <check> pass"), the check's detail and the CLI command it ran, the redacted diagnostics report, the agent's version and install path, and the scope constraint. "fix" lets the agent repair the failing tool and asks before changing anything outside it; "investigate" changes nothing and proposes a fix.
- The task records `diagnosticCheck: <name>`. Diagnostics shows the row as "Fix task running" or "Waiting for your review" while it is open. When the task is accepted, pacer reruns that check; the row reads Fixed only if the check passes.
- No credentials or secrets go into the brief; the report already redacts them.

## Pacer-internal failures and the native process owner

- When `PACER_HOST_SOCKET` is set, TypeScript plugin calls (`registry.call`) go to the native owner over the reverse bridge (`_host.plugin.call` on `$PACER_HOME/run/host.sock`) instead of starting a child or throwing. Call-scoped resources keep using `call_authority`. Without the socket, behaviour is unchanged.
- The doctor classifies errors by code, not by message text. A pacer-internal code yields `level: "warn"`, `evidence: "unverified"` and an `internal` remedy, and the check counts as "Couldn't check", not as a setup problem.

## UI

The approved design is the "Diagnostics Fix Flow" canvas (boards 1–4), to be carried into board 17 of the app redesign canvas.

- Header: Copy report, Run all checks, and one primary "Fix N issues automatically" while `auto` remedies remain.
- Summary sentence: how many problems, how many pacer can fix by itself.
- "Needs a fix" list: per row a status glyph, title, a neutral pill naming the remedy kind (Automatic, Review changes, Needs you, Agent), a plain-language detail, collapsed Technical details showing the operation the fix runs, and the one button. A running fix shows its progress in place; a finished one reads "Fixed and rechecked" or shows the new error.
- "Couldn't check" group: one card for all `internal` checks with the cause once, the affected checks listed, Restart pacer service and Send report to pacer.
- "Passed" collapsed.
- Review changes sheet: file list with Restore / No change / Not touched, undo note, Apply and recheck.
- Fix with agent sheet: what the agent gets, which executor pacer chose and why (Change), scope choice, Start fix task; then the task card with Open task.
- The Checking setup gate uses the same `remedy` field; `setupHealthRepairs` and `diagnosticRepair` stop inferring actions from names.
- CLI `pacer doctor` prints the remedy's CLI equivalent where one exists.

## Undo

`review` and file-changing `auto` remedies keep the previous copies (the existing install manifest backups). Diagnostics offers Undo for 7 days after a file-changing fix.

## Security

- Remedies only name registered operations; clients call them through the normal authenticated API with the operation's own schema and consent rules.
- `url` remedies are limited to https and System Settings schemes.
- `doctor.fix.delegate` builds the brief server-side from the stored result; client-supplied text never becomes part of the goal.

## Evidence

- Unit: remedy mapping for every check family; every emitted `op` exists in the registry; internal-error classification; reverse-bridge plugin call path with and without `PACER_HOST_SOCKET`.
- UI: view-model and component tests for each remedy kind, the fix-all flow, the Couldn't check group and both sheets; UI-18 light/dark and widths.
- Live (CT-11): under a sandbox native-owner service, Integration freshness, Planner check and Budget checks run instead of reporting `plugin_unavailable`; an `auto` fix runs and rechecks; a `review` fix previews and applies; a Fix with agent task is created and its acceptance reruns the check.
