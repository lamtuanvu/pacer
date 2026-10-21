# App-owned live validation with minimal permission setup

Status: Flow and permission-chip interaction approved in conversation after mockup review; inline implementation authorized. App-owned control and native/VoiceOver acceptance remain separate tracked work.
Date: 2026-10-21
Related: issue #239; [agent live-control design](2026-10-21-agent-live-control-design.md); [ADR agent control](../decisions/0002-agent-live-control.md).

## Intent and observed problem

An agent should inspect, operate and visually validate the ordinary Pacer desktop app without asking the user to diagnose macOS helpers or file paths. Existing service authentication and desktop sign-in should be enough for routine app workflows. No validation build, feature flag, additional listener or permission toggle is required for those workflows.

Live implementation established that the release app can capture its own WKWebView content and full main window. Capture-time PID, native window ID and executable hash are checked. A paced run captured 20/20 images. External AX input remains denied despite user-approved settings changes: macOS attributed the child helper request to its hosting Orca app, and a real owned-window AX query still returned permission-disabled after the visible toggles were enabled. Requesting consent did not display a dialog. A CLI boolean or settings toggle is therefore insufficient readiness evidence.

The user selected minimizing permission setup, with app-owned control for routine validation and guided permissions only for native OS controls or VoiceOver.

## Scope and alternatives

Recommended: extend the existing authenticated desktop worker to inspect and operate its own loaded UI. It already knows its service origin, session, native labels and window handles, and already performs self-capture. The CLI keeps the shared target/action/assertion contract.

An improved AX-only onboarding flow would retain OS-level input fidelity but still require broad hosting-app permission before every ordinary workflow. A separate remote-debugging listener could expose browser controls, but adds another authenticated transport and may change the shipped runtime configuration. Neither is required for this design.

This extends the existing agent design rather than replacing its evidence requirements. Native accessibility, external input, OS dialogs, VoiceOver and manual listening remain distinct acceptance scopes. App-owned control never reports those checks as passed.

## User experience

The default desktop workflow is: start the sandbox, launch/sign in the ordinary desktop app, then run existing live inspect/act/assert/capture commands. The CLI discovers a connected app-owned worker automatically. A successful action includes the resulting observation and self-capture. No Accessibility prompt appears for routine app inspection, navigation or control.

If the worker is absent or older, return a concrete capability error with the required app version and launch/sign-in action. Do not silently switch to desktop-wide input or ask for unrelated permissions.

An explicit native mode requests macOS/VoiceOver checks. Setup reports the missing capability, the responsible hosting app when established, and whether attribution is inferred or verified. Show a Validation setup dialog in the existing desktop Diagnostics area, using the existing DS dialog and controls. Present the selected capability, hosting-app name/icon, permission status, Request Access, Open Settings and Check Again actions. CLI/JSON consumers receive the same structured readiness state. While the dialog is visible, bounded read-only rechecks can detect approval automatically; closing it cancels polling. The dialog offers an OS permission request and an Open Settings fallback, then rechecks with a fresh helper and an actual owned AX query. It resumes the selected check only after that query succeeds. A suppressed prompt, stale grant or failed probe remains visible with diagnostics; it never tells the user that an enabled toggle proves readiness.

Native setup must not grant permissions, reset the privacy database, restart the hosting application, or change VoiceOver settings silently. A required host restart is a clear user-controlled recovery step. Routine app-owned validation remains available throughout.

## Contract and transport

Keep the shared ControlRequest/ControlResult schema, generation/revision-bound refs, exact semantic selector rules, scoped selectors, delivery state, absolute deadlines, assertions, replay and immutable evidence provenance.

Add `--backend app|native` for desktop commands: `app` by default, `native` only when requested. Reject this option on other surfaces. Results and capabilities name the backend. Requests requiring native accessibility or OS input refuse the app-owned backend rather than being downgraded.

Extend normal v3 desktop registration with additive app-control capabilities. Work is coordinated through service operations over the existing authenticated HTTP session. A separate bounded app-control queue uses the same proven per-instance worker credential boundary as capture; public client IDs alone cannot claim, renew or complete work. Keep v2 schemas and responses frozen.

Use `desktop.control.request`, `.claim`, `.result`, `.complete` and `.release` with typed inspect/act payloads; registration advertises `control: true`. No generic eval, script, shell, file path or URL execution operation is exposed. Use at most 16 control records, 64 registered workers and one nonterminal control request per desktop instance. Requests expire within 60 seconds; completed results within 30 seconds. Observations contain at most 2,000 nodes, depth 50, strings of 4,096 characters and 192 KiB serialized JSON; truncate with an explicit flag before reaching the existing 256 KiB completion-body cap. Per-command deadlines remain at most 60 seconds. Cancellation never starts another mutation. Document these constants in the protocol. Successful work returns bounded JSON observations and capture references; PNG transport stays on the existing authenticated binary route.

Capture and app-control scheduling must support a sequential scenario longer than the retained-image capacity without repeating a delivered action. Add `desktop.capture.release {request_id}` under normal service authentication. The harness releases a downloaded capture only after its evidence file and hash are durably saved; release deletes the broker image/record and is idempotent. A failed save preserves the result until its ordinary expiry. Likewise, `desktop.control.release {request_id}` acknowledges a saved terminal observation/result, preventing completed control records from blocking long sequential scenarios while retaining bounded storage. Do not silently weaken memory caps or discard undownloaded evidence. Preserve and document intentional backpressure.

## App implementation

The Rust desktop worker accepts only owned main/tray labels and verifies native window identity at execution time. Before each operation, verify the webview's exact signed-in service origin and the worker/session identity. Foreign navigation, expired authentication, replaced windows or disconnected service refuse work before input.

A fixed app-owned bridge inspects controls and resolves typed operations inside the existing WKWebView. The bridge is shipped code, not caller-supplied JavaScript. DOM inputs are serialized as data. Accessible-role/name resolution, ancestor scope, redaction and bounded observations follow the shared browser contract; extract reusable logic where that avoids two conflicting selector implementations.

Refs identify actual DOM nodes in a document generation, not only paths or names. Navigation and node replacement invalidate refs. Resolve semantic actions exactly once. A per-window writer lease serializes mutations. Revalidate the target and deadline immediately before dispatch.

Support existing app control kinds only where faithful delivery can be confirmed. Report whether delivery used app-owned DOM/event dispatch or native OS input. JavaScript-driven clicks and focus changes do not prove trusted keyboard behavior or AX semantics. Unsupported native controls remain explicit capability errors.

Run native window/webview work on the correct thread. Await asynchronous completion with bounded cancellation. Once an action may have been dispatched, retain unknown/delivered state and never retry it automatically. Observer and capture recovery may retry read-only work within a separate budget.

## Evidence and security

Keep normal loopback Host/authentication/Origin protections and the 256 KiB operation body cap. No CORS, token-in-query, new production listener, global keyboard control or arbitrary native-window access is introduced.

Bind every response to the registered desktop instance, actual owned process/window, loaded origin, app version/executable hash, document generation and request ID. Validate bounded observations before accepting them as evidence. Redact sensitive field values from observations, requests and screenshots using the existing rules.

Each step records backend, actual delivery mechanism, source/build provenance, assertion result and self-capture method/hash. App-owned screenshots prove app paint; they do not prove desktop accessibility, VoiceOver utterances, or manual listening. Separate verdicts prevent routine workflow success from hiding unavailable native checks.

## Validation and completion

Use focused regression tests for public-ID/foreign-worker authorization, expired/restarted proof, foreign origin, stale refs/node replacement, ambiguous selectors, wrong native window, expired preflight, observer failure after delivery, cancellation and image/observation bounds. Tests must demonstrate that a delivered mutation is never replayed.

Run actual normal-release desktop scenarios for Settings to Updates, keyboard/focus behavior within the supported app-owned contract, Unicode entry, main/tray navigation, document/window replacement and authentication loss. Save observations and visually inspect self-captures. Exercise long sequential scenarios across queue/artifact retention boundaries.

Native OS/AX and VoiceOver tests run separately when the environment is actually ready. Calibrate actual speech acquisition on two distinct fresh utterances; restore owned VoiceOver state on success, failure and cancellation. Manual listening remains a separate UI-2 obligation. Unavailable native checks are UNVERIFIED.

Run required TypeScript, UI, Rust, release-build and generated-protocol checks. CT-11 live evidence and current-head implementer/UI/QA reports remain required. Keep all working evidence in .work; never commit machine-specific paths or private artifacts. No exception, merge, publish or release is granted by this design.

## Acceptance

- A fresh agent can run routine desktop workflows through normal service/app authentication with zero Accessibility setup.
- The agent can inspect, act, assert and capture the real normal-release main/tray UI with exact-target and no-repeat guarantees.
- The user sees a guided, attributable and verifiable permission flow only for a selected native/VoiceOver capability.
- Evidence clearly distinguishes app-owned workflow checks from native OS/accessibility and speech checks.
- Security, bounded-resource and repository evidence rules continue to hold.

## Approved permission chip interaction

Approved in conversation: the user selects Enable native checks, the relevant macOS settings page opens, and a compact floating chip contains the actual responsible hosting app's bundle URL and icon. The user drags the app into the OS list and approves any remaining toggle/authentication. Pacer never grants the permission itself.

The chip follows the System Settings window when it moves, tracks display changes, stays within visible screen bounds, and docks over the bottom of the settings list so its drag destination is immediately apparent. It remains visible when another application receives focus, while the selected Settings window remains on screen. Tracking uses window-server bounds for the known Settings process, not AX event subscriptions that would require the missing permission. The compact row contains the responsible app icon and name, a direct “Drag into the list above” instruction, Show app, and dismiss actions; narrow Settings windows hide the secondary Show app action while retaining the drag target and dismiss action. Stop following while the app itself is being dragged. Hide with the settings window; dismiss on cancellation, settings closure, bounded timeout, or verified access. Provide a keyboard-accessible Show app in Finder fallback.

Use a shared native helper panel for the harness and ordinary release app. Resolve the hosting application from the running process ancestry and report attribution as inferred unless established; do not substitute the helper binary. Verify both trust and a successful read of an exact owned app window before reporting readiness. Dropping alone does not complete setup. Native/VoiceOver results remain separate from app-owned checks.
