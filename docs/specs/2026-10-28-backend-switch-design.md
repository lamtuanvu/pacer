# Switch the execution backend from the UI and CLI

Date: 2026-10-28. Status: approved design. Superseded in part by [Orca terminal execution](2026-10-28-orca-terminal-execution-design.md): Orca selection currently runs direct (see that spec), and core receives the readiness check by injection rather than calling OrcaClient.

## Problem

`execution.backend` in the strategy selects whether delegated tasks run as supervised Orca workers or under pacer's own (direct) supervisor. Users can only change it by editing `strategy.yaml` or by setting `PACER_BACKEND` for one command. Neither the web UI, the TUI dashboard nor `pacer config set` exposes it.

## Current behavior (unchanged by this work)

- The schema accepts `auto`, `orca` and `direct` (`src/config/execution.ts`).
- `selectBackend` (`src/exec/backend.ts`) runs direct even when the backend is `orca` (since #273); see the Orca terminal execution spec.
- `PACER_BACKEND` overrides the strategy.
- Managed (`pacer`/`orca` source) accounts, connection accounts and interactive runners always run direct.

## Design

### 1. Config key (core, API, CLI)

- Add `execution.backend` to `CONFIG_KEYS` in `src/core/config.ts`.
- Effective value: `orca` when the strategy's validated backend is `orca`, otherwise `direct` (covers `auto` and unset). `source` follows the existing rule (`default` when the key is absent).
- `parseValue` accepts only `orca` or `direct`; anything else throws `CoreError('invalid_input', 'execution.backend must be orca or direct')`.
- The write goes through the existing `set` path, so the YAML edit, preflight validation, conflict detection, undo command and `publishConfigChange` all apply unchanged. Writing `direct` writes the literal `direct`.
- Orca readiness hint: when the new value is `orca`, `set` asks the Orca client for status (`OrcaClient(ctx.run, ctx.env).status()` + `isReady`). If it is not ready, or the check throws, the write still succeeds and the result carries `warning: "Orca isn't running; tasks run directly until it is."`. The warning is also pushed into `notes` so the CLI prints it. Orca is never queried by `config.get`.
- `config.set` API result gains the optional `warning` string (additive). Regenerate protocol docs if the op output is documented there.
- CLI: `pacer config get execution.backend` and `pacer config set execution.backend orca|direct` work through the existing `configCmd`; no new command.

### 2. Web UI

In `MachineSection` (`app/src/screens/settings/General.tsx`), add a `Field` labelled "Task backend" with a `ChoicePicker` (`direct` → "Direct", `orca` → "Orca"), help text "Orca runs tasks as supervised Orca workers; tasks run directly when Orca isn't running.". Selecting runs `config.set` with `{key: "execution.backend", value}`. The warning, when present, is shown through the section's existing `Feedback`. Rebuild `src/app/assets.generated.ts`.

### 3. TUI dashboard

In the `machine` builder (`src/dashboard/screens/settings.ts`), add a "Task backend" field after "Parallel tasks" with ← → toggling between Direct and Orca via the existing `set` helper.

## Error handling

- Invalid values: `invalid_input` from core; CLI exits 2 with the message.
- Orca status failure never blocks the write; it only produces the warning.
- Concurrent edits: existing `pendingEdits` and strategy-changed checks.

## Testing

- Core/CLI unit tests: get maps `auto`/unset → `direct`, `orca` → `orca`; set accepts `orca`/`direct`, rejects others; set to `orca` with Orca not ready returns the warning and still writes; set to `orca` with Orca ready returns no warning; undo command is correct.
- Web UI test: the picker renders the current value and calls `config.set` with the chosen value.
- Dashboard test: ← → toggles the value.
- Live validation (CT-11, `bun run live`): toggle via CLI and web UI, confirm `strategy.yaml` and `pacer orca status` reflect the change.

## Out of scope

- Changing backend selection semantics or removing `auto` from the schema.
- Showing Orca readiness when the settings screen loads.
- A dedicated `pacer backend` command.
