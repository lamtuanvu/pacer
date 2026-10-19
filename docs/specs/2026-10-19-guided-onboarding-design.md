# Guided onboarding

Tracking: lamtuanvu/pacer#130 (wave 2). Wave 1 (honest cold start, no placeholder executor, signed-out executors excluded, consent for the service) is a prerequisite.

## Problem

Setup today ends when files are written: strategy, service, hooks. pacer's value appears only when the planner hands work to an executor and the user reviews the result, and nothing leads a new user there. The web app has no Setup screen (incomplete setup silently redirects to Settings), the TUI shows a text list, and the desktop app has no setup of its own.

## Goal

A new user goes from install to an accepted first delegation in one guided flow, in whichever client they opened, without reading docs.

Done means:

- Every client (web app, desktop app via the web app, TUI) shows the same checklist from the same service data.
- Each pending item says what is wrong in words and offers one action (a button in the app, a key in the TUI). A terminal command is shown only where a provider's own login needs one.
- The last step runs a harmless first delegation and ends on its review.
- `pacer uninstall --all` reverses everything setup did.

## Non-goals

- Shipping the desktop app with a bundled CLI (wave 3, blocked on OD-5).
- Changing routing, pacing or mode rules.

## Checklist model

Extend the pure `setupChecklist` (`src/setup/checklist.ts`). It stays the single source; the worker, web app and TUI render it.

| id | Title | Required | Done when | Action |
|---|---|---|---|---|
| `binary` | pacer | yes | version known | — |
| `planner` | Planner | yes | planner chosen **and** signed in (cheap login check) | choose planner; show provider login command |
| `service` | Background service | yes | installed and running | install (with the consent text from wave 1) |
| `connect` | Connect planner | yes | planner agent's hooks installed and intact | connect (shows the file preview, incl. status line) |
| `executor` | Executor | no | ≥1 executor installed, signed in, and not excluded | add executor (existing wizard; Ready after test task) |
| `usage` | Budget data | no | planner verdict is not UNKNOWN | "Start a session in <planner> once" |
| `first` | First delegation | no | one task reviewed (accepted or rejected) | "Try it" (below) |
| `live` | Orca panel | no | as today; shown only when Orca is installed | as today |
| `agent:<id>` | other agents | no | as today; executor-only agents show "no connection needed" | connect |

`complete` stays "all required done", so pacer works without an executor. `ready` is a new field: complete **and** `executor` and `first` done. Clients show the checklist until `ready`, then collapse it into a single "Setup ✓" row.

Items get `action` (a service API action id) next to the existing `command`. Clients prefer `action` and fall back to `command`.

## Try it: the first delegation

- A fixed brief, kind `docs`, in a temp git repo created under `PACER_HOME/onboarding/` (never the user's repo): "Summarize README.md in three bullet points into SUMMARY.md". The README is a short bundled text explaining what pacer just did.
- Routed normally, so it exercises the real top executor and shows which one was picked and why.
- The client follows the task live and opens its review with the diff. Accept or reject both complete `first`. A failure shows the executor's error and a "Try another executor" action.
- Tasks are tagged `onboarding` so they're hidden from history stats and the dashboard's "finished today" count.

## Clients

- **Web app**: restore the Setup screen from the app design spec. It takes over work screens while `complete` is false, and shows as a dismissible banner on Home while `complete && !ready`. Replace the silent redirect to Settings.
- **TUI**: the existing setup block gains key hints (`s` service, `c` connect, `e` add executor, `t` try it).
- **CLI `init`**: after connecting, offer "Try a first delegation now? [Y/n]". It runs the same flow and prints the review command.
- **Desktop**: no extra work. It opens the web app, which shows Setup.

## Uninstall

`pacer uninstall --all [--yes]` lists everything and then removes it after a single confirmation: every connected agent (`uninstall <agent>`), the service, the Orca plugin registration, `PACER_HOME`. It finishes by printing the binary path to delete, or deletes it with `--binary`. The web app's Settings gets "Uninstall pacer", which shows the same list.

## Testing

- Unit: checklist rules for each item state, including UNKNOWN usage, signed-out planner and no executor.
- Live (CT-11): a fresh `PACER_HOME` on Claude-only, Claude+Codex, and Codex-signed-out machines walks each checklist to its expected end state; Try it runs to review on Claude+Codex; `uninstall --all` leaves no files under `PACER_HOME` and no hooks in the agent settings.

## Open questions

- Should `first` be required for `ready`, or should rejecting the offer once count as done? Proposal: an explicit "Skip" marks it done.
