# The assistant is a bundled plugin extension point — 2026-10-28

Status: implemented with the first assistant PR; the open decisions in the spec still await the maintainer.
Source: [always-on assistant design](../specs/2026-10-28-always-on-assistant-design.md). Builds on
[plugin host and strangler migration](2026-10-19-plugin-host-and-rust-strangler.md).

## Context

People ask pacer questions that its screens answer only in pieces. An assistant needs a model backend, which would add a
model integration to the host (P13 keeps the host minimal) and would let model output reach the service's operations.

## Decisions

- **D1. `assistant` is a plugin extension point** with one method, `assistant.respond` (plugin protocol 1.2.0). The host
  runs every read tool itself and calls the plugin again with the results, up to `maxToolRounds`. A returned tool call is a
  request. The plugin never calls client ops and never receives an API token, grant or session.
- **D2. Bundled only.** Plugins are unsandboxed child processes today, so the host refuses an installed plugin whose
  manifest contributes `assistant`. This is revisited when installed plugins are sandboxed (milestone M3).
- **D3. The backend is an endpoint account.** The bundled `pacer-assistant` talks to an OpenAI-compatible endpoint. It reads
  the account's key through `capability.secrets.resolve`, which the host answers only for that plugin and only for the
  endpoint account the user chose. A native agent CLI backend is not offered until an adapter proves its tool-less mode.
- **D4. Actions are proposals.** The model can only return `propose_action` for an allowlisted op. The host validates the
  parameters, records `expect_rev` when the card is made, and draws the card's text from the op. The app runs the op with
  the user's own session after a click.
- **D5. History stays on this machine.** Conversations live in the service's SQLite store (0600, `secure_delete`), with
  bounded retention and a clear action. Streaming is ephemeral and never enters the event outbox, which carries only an
  `assistant` event with no text.
- **D6. Usage is its own record.** Each turn's token usage goes to `assistant_usage`, outside any root task, with the same
  `measured`/`partial`/`unknown` coverage as attempts.

## Consequences

- The plugin protocol gains an extension point, a method and a capability (additive, P14). The client protocol gains
  `assistant.*` ops (additive, P4).
- The ⌘K `?` mode, its footer hint and a top-bar button are not part of this change: the command menu is separate, and
  `assistantEntry` (`app/src/shell/assistant-entry.ts`) is the hook it wires. The launcher is the design board's floating
  pill, which differs from the spec's "top bar" wording.
- Streamed model tokens and the Insights row for assistant usage depend on work that has not
  landed (plugin notification dispatch, Insights); see the spec's open decisions and the PR notes.
