# Agent control parity through a discoverable CLI

Status: Approved by the maintainer on 2026-10-24; implementation in progress.
Date: 2026-10-24

## Intent and acceptance contract

Anything a user can do with Pacer's desktop app, tray, or TUI must have an
agent-accessible equivalent through the Pacer CLI, documented by a compact Pacer
skill. Agents should discover only the operations needed for their current task,
without loading the whole product manual into context.

Parity means equivalent observable results and supported inputs, including state
inspection, configuration, execution, review, interaction with running sessions,
attachments, diagnostics, maintenance, appearance, and native app controls.
Viewing, searching, filtering, or navigating a screen can be satisfied by a
structured query returning the same information; reproducing keystrokes is not
required. Opening a particular desktop screen must also remain possible.
Client-local settings and native actions are included. OS-owned authentication
or permission approval remains with the user: agents can start the flow and
inspect its status, but cannot fabricate approval or acquire native credentials.

The final parity inventory must have no unexplained or unsupported user action.
Missing runtime evidence is UNVERIFIED, never an implicit exception.

## Approaches

The maintainer selected a discoverable CLI with JSON operation invocation and a
small skill. Reuse the existing versioned operation registry and add specialized
commands only where an operation call cannot convey streams, binary content, or
native interaction well. This minimizes duplicated mappings and context use.

An alternative was a named CLI command for every UI action. It gives convenient
individual commands but duplicates a changing API catalog. Existing ergonomic
commands remain supported; they are not the coverage boundary.

An expanded MCP catalog would add another mapping and require client
reconfiguration. MCP remains optional; expanding it is not required here.

## Current foundation and gaps

- `src/api/ops.ts` and its session/desktop modules hold operation descriptions,
  Zod parameter schemas, validation, and execution handlers.
- `hello` advertises names, but does not describe parameter schemas. The protocol
  documentation already derives JSON schemas from this registry.
- `pacer api --stdio` supports v2 by default and explicit v3 negotiation. Preserve
  that contract. New one-shot discovery/call commands use v3.
- `connectClient` can select HTTP or an in-process fallback; the latter currently
  implements v2 even when v3 was requested. New calls must not silently downgrade.
- Sessions use separate live wire transports; attachment uploads use HTTP binary
  routes. `session start --attach` and terminal attachment already cover parts.
- Appearance is browser local storage; native window/tray actions use Tauri IPC.
  They are not presently callable through registered service operations.
- The generated skill in `src/install/skill.ts` teaches delegation only.

## Discovery and invocation

Add these public forms, preserving existing `api --stdio` behavior:

```sh
pacer api list --json
pacer api list --prefix runner. --json
pacer api list --search settings --json
pacer api describe runner.settings.save --json
pacer api call runner.settings.save --params-file settings.json --json
pacer api call runner.settings.get --json
```

`list` returns a deterministic, compact catalog: operation names and short
descriptions, protocol/pacer versions, and the applied filters. It omits parameter
schemas. Prefix and case-insensitive text search combine when both supplied.
`describe` returns the exact operation name, description, and JSON input schema,
including required fields, enum choices, defaults, and constraints representable
by JSON Schema. Semantic refinements still run at invocation. Unknown names return
`unknown_op`; empty search results succeed with an empty list.

Expose registry-backed discovery through additive v3 operations (proposed names
`api.list` and `api.describe`) so a CLI connected to a different service version
describes the service that will execute the call. Derive metadata from existing
OpDef/schema definitions, sharing the existing schema conversion where practical.
Never maintain a second hand-written catalog. Catalogs include their discovery
operations. A connected older service lacking discovery returns an actionable
version error; it must not substitute local schemas for remote operations.

`call` defaults params to `{}`. Accept `--params-file <path|->` for a JSON object;
`-` reads stdin. An optional inline `--params <json>` may be provided for small
objects; mutually exclusive sources, invalid JSON, arrays, oversized input, and
unknown flags fail before dispatch. File/stdin input is the skill's recommended
form, particularly for secrets. Do not log input bodies or echo them in errors.

JSON mode writes one result to stdout on success, with a stable envelope
`{ "result": ... }`. Failures write `{ "error": { "code", "message", "hint"? } }`
to stderr, leave stdout empty, and exit nonzero. Invocation/validation errors use
exit 2; transport/execution errors use exit 1. Existing commands' contracts do not
change. Human-readable discovery is concise; JSON mode is non-interactive.

An explicit service refusal or authentication/connection failure after selection must
not trigger an in-process retry. A mutation with a lost response has an unknown
outcome; do not replay it automatically unless the operation supports a matching
idempotency key.

Calls use the authenticated versioned client and existing service policy. Preserve
revision checks, consent fields, executor-session restrictions, and errors. Never
interpret an operation name or input as a shell command. Neither discovery nor
generic invocation bypasses an operation's existing authorization.

When no service is running, registry discovery and operations that already support
local execution may use a correct v3 in-process client. Service-owned facilities
(native clients, live sessions, uploads, desktop updates) return clear prerequisite
errors. Do not start competing owners or claim native actions succeeded locally.

## Complete the parity inventory

Before implementation, enumerate user actions from app screens/settings, tray,
TUI screens/controller/handoffs, and native desktop menus/IPC. Record a durable
coverage matrix in `docs/agent-control.md`: user capability, source surface,
discovery name or dedicated command, prerequisites, result/status observation, and
validation case. Store detailed scratch evidence under `.work/`.

Audit all these areas, without treating the examples as an exhaustive action list:

| Area | Required agent capabilities |
| --- | --- |
| Overview and history | Snapshot/status, attention actions, activity, counts, repository selection, query/filter/pagination and task detail/log/diff |
| Setup and configuration | Agent detection/connect/disconnect, onboarding, account creation/edit/test/sign-in/removal, model discovery, runner setup/order/settings, routing, strategies, project policies, notifications and service configuration |
| Work | Delegate, start/resume/end sessions, observe output/state, answer questions, take/release control, submit terminal input, resize, retry, review, stop, dismiss, archive/restore and worktree cleanup |
| Attachments | Initial and later uploads, supported types/limits, preparation/delivery and observable failure; use public routes rather than private files |
| Hosts and plugins | Inspect, configure, test, pause, map repositories, setup/clean, terminal handoff; install/enable/disable/remove/diagnose plugins |
| Maintenance | Diagnostics and every repair action, CLI/service and desktop updates, cancellation, progress, revision-bound restart and uninstall actions present in the UI |
| Client controls | Appearance choice, opening supported routes, window minimize/maximize/close, tray show/hide and app quit, plus any additional user-facing native menu actions found in the audit |

An existing command or operation qualifies only when an agent can supply the same
inputs and observe success/failure. A command that merely opens an interactive
wizard is not sufficient if the UI can complete the same product action directly.
A provider/OS login handoff is an explicit prerequisite, with status observation.

## Streams, files, and native clients

Keep `watch`, `wait`, and `attach` as ergonomic entry points. Add scriptable session
input/control/output modes as needed after auditing current wire capabilities.
Input should support files/stdin and explicit control ownership; output should be
bounded or streamed with a documented offset and termination contract. Preserve
single-controller conflicts, disconnect cleanup, replay limits, and executor rules.
Terminal input goes to the selected PTY under existing session control, never to
a newly constructed host shell command. Human and agent views share the same host.

Expose attachment upload and delivery through a dedicated CLI path reusing public
HTTP routes and validation. Include draft/task identity and safe attachment IDs;
never dump uploaded content or credentials. Both initial and later attachment
workflows must be covered.

Add missing durable product capabilities in core operations first. For native or
client-local actions, use targeted requests to a registered connected client,
modeled on the existing authenticated desktop capture/update brokers. Targeting
must identify the client/window; reject unavailable or ambiguous targets. Return
an observable request ID/status, and acknowledge only after the client applies an
action. A timeout/disconnect is a failure or unknown outcome, never success.

Use a typed allowlist of actions with validated payloads, not arbitrary JavaScript,
Tauri command names, shell commands, or selectors. Keep window/session-origin
checks and runtime-scoped Tauri capabilities. User-visible appearance remains
per device/client as today; an agent targets that device/client rather than
silently turning it into an account-wide preference. Connected browser clients
can receive relevant appearance/navigation requests; native-only requests require
a native worker. TUI queries can return equivalent data without remotely steering
an arbitrary terminal. Presentation preference choices exposed by the TUI must
also have a CLI equivalent.

The builder chooses concrete broker operation names and session CLI spelling after
the action inventory. Reuse existing brokers/transports where their security and
acknowledgment contracts fit; do not create another network listener. Missing
capabilities remain in scope, including cases requiring app/desktop changes.

## Compact skill and documentation

Keep the skill focused on choosing an interface, filtered discovery, describing
one operation, invoking JSON via file/stdin, observing jobs/streams and handling
conflicts. Retain planner/executor role boundaries, budget/delegation guidance,
review/verification obligations, consent semantics, and user-requested strategy
changes. Reference discoverable operations instead of embedding their full list.

Document the JSON contracts and examples in `docs/cli.md`; keep the coverage matrix
and transport/prerequisite guidance in `docs/agent-control.md`. Refresh installed
skills through the existing installer/update path, not direct edits to local skill
copies. Update generated protocol docs and CHANGELOG for shipped behavior.

## Validation and completion

Tests must cover discovery/schema freshness, filtered/unknown operations, input
parsing and size limits, stable JSON/exit behavior, dispatch through the selected
service, v3 fallback parity, secret-safe failures, role restrictions, conflicts,
and prerequisites. Add targeted tests for each newly bridged capability, including
native acknowledgment failure, client scoping and session control contention.

Run applicable typecheck/test/build, generated-doc freshness and affected Rust/UI
checks. Follow CT-11 with `bun run live`; compare representative agent actions with
the desktop/TUI and exercise every newly added behavior. Use real executors where
execution is involved. Remote live execution still needs separate approval under
SEC-6; tests cannot silently act on real remote hosts. Native/UI changes require
UI compliance, screenshots and independent UI/QA evidence under UI-24. Manual
VoiceOver is WAIVED only under the existing expiring VO-TEMP-2026-10 exception.

Preserve the live harness D3/D8 guards. Teach the guarded CLI wrapper about generic
invocation so `api call` cannot bypass a blocked named command, including through
no-service or forced in-process execution. A proxy refusal must never retry locally.
Extend safe fixtures and the harness where needed to validate new capabilities
without touching real integrations, keys, service managers, installations or remote
hosts. Fixture success and real-environment success are distinct evidence; record
remaining blocked side effects as UNVERIFIED. Do not disable guards to obtain PASS.

The matrix records evidence or UNVERIFIED for each action. Independent project
review covers final changed content; resolve blocking findings, rerun affected
validation and obtain independent fix review. Full parity is complete only when
all required matrix rows and evidence pass. Work may be implemented in dependent
chunks, but completing discovery alone does not satisfy the overall request.

## Governance and builder decisions

Constitution 0.11.0; apply established ARCH-1–5, ARCH-8–9, ARCH-12–14,
P13–15 and API-1–6,
SEC-1–8 as scoped, CT-1–6/8/11, REPO-1–7 and the instructed REPO-10 review gate.
UI changes additionally load all applicable UI rules/reviewer definitions; Rust
changes load the Rust and crate rules. Preserve P4 compatibility and P5 secrets.
Any new adapter capability follows the existing plugin boundary; do not add a
built-in adapter fallback or host entitlement checks. No governance amendment is
proposed. Record a new ADR if implementation introduces
a durable architectural choice beyond existing client/API and broker patterns.

The builder chooses module organization, exact specialized command names,
implementation sequence and proportionate test cases. User-facing input/output
contracts and complete parity above are requirements. Do not narrow scope to
already registered operations or exclude native controls without maintainer input.
