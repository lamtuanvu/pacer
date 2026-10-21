# Agent control for live validation

Status: conversational design approved; written spec awaiting maintainer review.
Date: 2026-10-21
Issue: [#239](https://github.com/lamtuanvu/pacer/issues/239)

## Intent and agreed scope

Agents must be able to operate Pacer end to end during live validation: discover
targets, inspect state, navigate, interact, observe results, diagnose failures and
produce inspectable evidence. One CLI with structured JSON covers desktop,
web/tray and TUI. A thin MCP wrapper can follow; it must reuse the CLI's control
implementation rather than introduce another behavior contract.

Extend `bun run live`. Keep its sandbox lifecycle, disposable repository, guarded
service proxy and PASS/FAIL/UNVERIFIED reports. Full control means all supported
interactions within that sandbox; it does not remove D3/D8 restrictions or
authorize installation, credential changes, updates or remote execution.

Desktop self-capture ships in the regular application. There is no special
validation build or mode switch. Native window capture is the default; webview
content snapshots support focused layout inspection. External capture remains
available when the application cannot respond. Every UI action automatically
attempts a resulting-state screenshot, or text capture for the TUI.

This spec deliberately expands #239's native-only scope to one cross-surface
interface. Its original production-versus-instrumented-build distinction is
replaced by normal-release self-capture. Its isolation, observer calibration and
honest VoiceOver evidence requirements remain applicable.

## Project constraints

Use `.project/constitution.md` (0.8.0 heading; established rules remain in force),
`.project/context.md` and `.project/decisions.md` as governance references.
Applicable rules:

- ARCH-1–5, ARCH-8–9 and ARCH-12–14: service ownership, multi-client safety,
  planner/host neutrality, durable decisions and plugin boundaries.
- API-1–5: additive compatibility, generated contracts, structured errors and no
  free-form shell operation.
- SEC-1–5, SEC-7–9: credential protection, authentication, argument vectors,
  restrictive writes, desktop origin scope and CI hygiene. SEC-6 applies if a
  later validation explicitly includes remote hosts.
- CT-1–6, CT-8 and CT-11: tests, generated artifacts, Rust checks and real live
  evidence. UI-2, UI-18 and UI-24–25 apply to affected presentation and review.
- REPO-1–6: untracked working evidence, spec/ADR locations, portable paths and DCO.

Reviewer definitions to carry into planning and review are architecture,
protocol-compat, security, qa and ui-accessibility under `.project/reviewers/`.
Some index/reviewer text still describes amendment 0.4.0 as proposed; the
constitution records adoption through #193 and governs mandatory UI/QA evidence.
No existing exception in decisions.md covers this feature. OD-2's ADR naming
conflict remains open; follow AGENTS.md's numbered form for a new ADR.

## Architecture and ownership

Three layers keep responsibilities separate:

1. The live session owns lifecycle, sandbox coordinates, target registration,
   leases, action history and evidence.
2. A shared control contract owns request validation, target resolution,
   deadlines, outcome reporting and evidence orchestration.
3. Surface adapters implement browser DOM interaction, macOS native
   accessibility/window interaction and tmux terminal interaction.

Keep harness orchestration in `scripts/live/`; adapters have focused modules.
Product state changes still go through versioned service operations. Fixture
preparation and API verification cannot substitute for exercising a UI action.
Production desktop capture belongs to the shell's native window layer, with
service-mediated authenticated request coordination rather than an independent
unauthenticated listener. Additive operation/event schemas and generated docs
describe that coordination before clients use it.

Capture is platform-dependent window functionality; keep it behind a narrow
adapter and honor ARCH-12 if supplied as a plugin capability. Do not move
window ownership into the domain core. Planning must record the final placement
and routing in an ADR before implementing the production API.

## CLI and result contract

Command spelling below is the proposed public contract. Existing lifecycle,
`pacer`, `login`, `tui`, `note`, `attach` and `report` commands remain compatible.
All control commands accept `--id` and `--json`.

```sh
bun run live targets --id validation --json
bun run live inspect --id validation --surface desktop --target main --json
bun run live act --id validation --surface desktop --target main \
  --selector '{"role":"button","name":"Check now"}' --action click --json
bun run live wait --id validation --surface desktop --target main \
  --condition '{"text":"You are up to date"}' --timeout-ms 10000 --json
bun run live capture --id validation --surface desktop --target main \
  --mode window --json
```

Discovery exposes supported operations and capture channels per target. Targets
identify a browser page/context, native process/window, or tmux pane. Browser
tray rendering and native tray integration have distinct surface identities.
Never claim native coverage from a browser tray screenshot.

Every result carries a schema version, run/command ID, target identity, outcome,
timestamps, current observation, evidence references and structured error when
applicable. JSON mode writes machine-readable results to stdout and diagnostics
to stderr. Failed commands return nonzero status without losing their result.
Harness errors distinguish busy targets, stale references, ambiguity, unavailable
capabilities, timeouts and uncertain action delivery. Product API errors retain
the established CoreError contract.

Inspection exposes accessible role/name/value/state, focus, geometry and
available actions where supported. Browser DOM and native AX remain distinct
observations. TUI inspection exposes screen text, cursor and key capabilities;
it does not invent semantic controls from terminal text.

## Interaction loop

The loop is inspect → act → observe → assert.

Element references are scoped to a target and snapshot revision. Before an
action, adapters revalidate the element and its identity. Navigation, process
replacement or invalidated elements reject old references. Semantic selectors
must match exactly one control. Coordinate actions are supported when semantic
access is unavailable and reference a specific recent image, its geometry and
scale; incompatible target geometry makes the request stale.

Actions include click, text entry, key press, scroll, selection, resize and
activation where supported. They report delivery separately from postcondition
success. Following delivery, collect a fresh observation and automatic capture.
Capture failure never causes an already-delivered action to be repeated.

Waits use explicit observable conditions and bounded deadlines, including
presence, absence, value/state, focus and terminal text. They do not equate
network silence with UI readiness. Timeout collects the available state and
capture. Uncertain mutations are never automatically retried: inspect their
effects before deciding the next action.

Assertions record expected and actual observations with evidence references.
Machine-checkable conditions may produce verdicts directly. Visual judgments
name the inspecting agent/reviewer and image; saving an image alone is not a
passing assertion. Existing manual notes remain supported and are identified as
such rather than silently upgraded to machine verification.

## Shipping desktop self-capture

Provide two native implementations behind the same capture request:

- `window`: OS-native capture of the selected Pacer window, used by default for
  desktop appearance and composition. Popovers, menus and dialogs may be
  separate targets and require separate captures.
- `content`: a WKWebView snapshot of the selected main or tray webview, useful
  for typography, layout, color, clipping and rendered focus indicators. It
  does not establish native chrome or OS-dialog correctness.

Use native APIs rather than DOM-to-canvas reconstruction. Apple documents
[WKWebView snapshots](https://developer.apple.com/documentation/webkit/wkwebview/takesnapshot(with:completionhandler:))
and [ScreenCaptureKit screenshots](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager).
Compile/run probes must establish supported SDK/OS behavior and permissions in
the actual Tauri shell before implementation promises become acceptance claims.

Authenticate requests through the existing local session, bind them to the
registered desktop instance and verify its service origin. Capture only owned
Pacer targets. Use request IDs, deadlines and bounded image sizes. Desktop
results cannot choose arbitrary write paths; the harness saves validated image
bytes into its evidence directory. No tokens or single-use auth URLs enter
public artifacts. Ordinary release use requires no validation toggle; OS
permission requirements are surfaced explicitly and never silently granted.

Metadata includes app/build identity, window identity, method, timestamp, pixel
dimensions, viewport dimensions and scale. Mark self-capture versus external
capture explicitly. A native capture failure may fall back to an external
observer, but the report must retain the failure and actual coverage. A content
snapshot is not silently substituted for native paint evidence.

## Concurrency and recovery

Use one writer per target, with a host-wide cooperative desktop lease for native
input and VoiceOver. The lease lives outside individual worktrees and records
owner, process/start identity and heartbeat. Never steal a live lease. Serial
GUI CI scheduling complements the lease; neither prevents uncooperative input.

Check exact app/process/window identity before native actions. Unexpected
foreground drift stops input and returns fresh state. Reconnection after a
restart rediscovers targets and invalidates old references. Cleanup signals
only verified owned processes and restores only settings changed by the run.
Interrupted cleanup leaves a resumable journal and explicit report findings.

## Evidence and accessibility

Store action events, observations, captures and report data under
`.work/live/<id>/evidence/`. Each step records surface, target, request, timing,
delivery, postcondition, observer health and artifacts with hashes. Run metadata
identifies source revision plus dirty-tree fingerprint, app/service hashes,
adapter versions, OS, viewport, scale, locale and fixture versus real data.

Automatic captures occur after each UI action; explicit before/after captures
remain available for UI-18. TUI actions capture text rather than fabricate image
coverage. Redact secrets and review artifacts before publishing. Evidence files
stay untracked.

PASS requires an observed expected behavior. A product mismatch is FAIL. Missing
observers, blocked side effects and inconclusive observations are UNVERIFIED
with reasons. A refused operation may pass its guard assertion while the
prevented installation/login/update remains UNVERIFIED.

VoiceOver uses actual navigation and observed speech output. Before Pacer
checks, a known-good control must produce two distinct fresh utterances to
calibrate the observer. Accessibility-tree text or generated speech cannot
replace that evidence. Transcript/audio channels report availability separately.
Restore owned VoiceOver state on success, failure and cancellation. UI-2's
manual VoiceOver obligation remains until explicitly amended; automated speech
observation alone does not satisfy it.

## Delivery milestones and acceptance

1. **Shared contract and web/TUI:** target discovery, JSON envelopes, capabilities,
   inspect/action/wait/capture adapters and compatibility with current commands.
   Prove browser interaction and real tmux input with captured results.
2. **Native control and shipping capture:** native discovery, AX interaction,
   keyboard/window actions, desktop lease and both capture modes in the regular
   release build. Prove main-window and tray captures, native theme/focus changes,
   origin isolation and external observation when self-capture fails.
3. **Assertions, evidence and replay:** declarative scenarios reuse the same
   operations. Produce current-build per-behavior reports and detect stale
   references, ambiguous selectors, navigation/restart, foreground drift,
   capture failure after delivery, timeouts and concurrent ownership.
4. **VoiceOver and reliability:** calibrated speech observation, restoration and
   unattended scenarios on a provisioned GUI runner. Record repeated-run
   duration/failure data before proposing a required CI gate. Do not assume a
   hosted runner has a usable unlocked desktop or granted permissions.

Inject known UI defects, blank/stale capture results and observer outages. The
harness must distinguish product failures from missing evidence and must never
turn failed observation into PASS. Test sandbox refusal paths without bypassing
the proxy. Exercise real executors only when validating delegation behavior.

Implementation verification includes the relevant typecheck, test, build,
generated-doc freshness, UI and Rust checks. CT-11 requires actual `bun run live`
exercise of changed commands and all affected surfaces, with report counts and
limitations summarized in the result. Independent UI/accessibility and QA
reports remain required for applicable changes. This design-only change is
exempt from runtime live validation and makes no claim that these capabilities
have been implemented or exercised.

## Planning handoff

After written-spec approval, produce the implementation plan under
`.work/plans/`, carrying the rule IDs and reviewer references above. Record the
durable architecture in a numbered ADR. Planning must include concrete native
capture/control feasibility probes and finalize the browser backend, authenticated
desktop request routing, adapter/plugin placement and payload limits. These are
implementation selections within the agreed contract; any probe that changes
the supported scope or release-build requirement returns for design review.
