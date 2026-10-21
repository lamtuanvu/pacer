# Interactive entry and persistent agent sessions

## Intent and approved scope

Pacer becomes the place a user starts coding work and continues interacting with their chosen agent. The default experience is interactive. The user approved a mature embedded terminal with a polished Pacer shell for the first release, preserving the selected agent's supported features and attachments.

Success means a user can enter a request, attach context, choose a repository and executor, start in a new worktree, and immediately work in the agent's real interface. Returning to Pacer reconnects to the same live session. Ending an assistant turn does not end the conversation.

## Approach

Reuse the existing xterm.js renderer, service-owned PTY, authenticated WebSocket transport, control arbitration and recording. Extend the current task-backed session machinery with an explicit interactive conversation lifecycle. This keeps workspace, routing and activity visible to existing clients while distinguishing conversations from finite delegated tasks.

Alternatives considered: a normalized chat client would require agent-specific structured protocols and feature translation; an external terminal would preserve agent behavior but break the integrated entry experience. The embedded native agent interface is the chosen first release. A future chat surface can use the same service capabilities without changing this contract.

## Launch screen

The initial application route presents a large request composer, attachment tray and Start session action. Repository and executor selectors sit beside or below the composer. Recent and active sessions remain reachable, with settings and budget information in secondary navigation.

The executor selector shows agent and account together, with readiness and available usage information. An automatic choice resolves to a named eligible interactive executor before launch. Routing filters by interactive and attachment capabilities. Once started, a conversation stays bound to that agent and account; budget exhaustion never silently moves it to another agent or account.

The workspace selector defaults to New worktree. Show the resolved base branch, with a branch picker available before launch. Resolve the base through existing repository policy and worktree machinery; never label an unspecified base Current branch. Record the selected reference and resolved commit. Local uncommitted changes are not included in a new worktree.

The advanced Use existing checkout option requires choosing a concrete checkout, displaying its branch and path and whether it has uncommitted changes. The service checks write ownership and returns conflict if another session owns it. A new worktree based on a selected branch and using an existing checkout are separate choices.

Kind and acceptance commands leave the primary interactive launch form. The ordinary action reads Start session. Existing finite delegation remains available through a secondary action and existing API behavior.

## Working screen

The terminal occupies the primary region and receives focus once the new session is ready and control is acquired. A compact header shows repository, workspace branch, agent/account and connection/activity state. Session navigation, Changes, original request and attachments, Open in editor, Open in terminal and End session are available through the shell. Actions appear only when supported.

Agent slash commands, tools, permission prompts, selection menus and keyboard interactions remain native terminal behavior. Pacer shortcuts yield while the terminal is focused. Preserve normal terminal copy, paste, selection, Unicode, IME, scrolling, resizing and bracketed paste. Focus and control state must be explicit; reconnect must never silently steal control from another viewer.

The launcher requests control for its new session automatically. Other windows attach as viewers unless control is available or explicitly transferred through the existing arbitration protocol. Closing a window releases its viewer/control connection but leaves the agent and worktree running. Service/application updates follow existing admission rules and cannot terminate work as an incidental UI action.

## Attachments and feature fidelity

The composer and working shell support file picking, drag/drop and pasted screenshot images. They share a service attachment pipeline. Show filenames, previews for supported images, upload progress, errors and removal before submission. Files remain outside git in private service storage; do not add them to the repository or commit them automatically.

Adapters declare supported launch, live attachment and resume mechanisms. The host owns attachment storage and dispatches typed attachment references through the plugin contract. Use native image/file arguments or the agent's documented attachment mechanism where available. Ordinary files may be supplied as readable paths with an explicit prompt reference; a path reference is not evidence that the model received native image input. Agent-visible paths must be accessible within that session's sandbox.

During a session, the shell can attach more files through the same capability-aware path. Native terminal key sequences alone do not carry clipboard image bytes. Intercept image paste in the shell and use the adapter's supported delivery mechanism. Delivery must not unexpectedly submit a pending agent prompt; if the agent requires an explicit user step, show it beside the attachment. Failed delivery retains the attachment for retry and never claims success.

Unsupported attachment types are explained before launch or delivery, with the capability-aware executor picker available before launch. Arbitrary binary files can be stored and referenced, but Pacer only promises interpretation supported by the selected agent. Folder upload, directory recursion, archives and remote attachments are separate follow-up work. Do not advertise complete agent parity without an exercised capability matrix.

Initial limits: 20 files per attachment batch, 25 MiB per file, 100 MiB per session. Enforce limits while streaming. Use opaque IDs and server-generated storage names, preserve a sanitized display filename, reject traversal/symlink tricks and scope reads to the authenticated session. Uploaded content is private task data, never executable service instructions. Unclaimed draft uploads expire after 24 hours; claimed files follow session retention, preserving files required by a resumable session.

## Persistent conversation lifecycle

Add an explicit per-task interaction mode, preserving existing delegated defaults for old clients and records. The launch operation selects conversation mode per session rather than changing a runner's global session configuration.

A conversation may be starting, working, waiting for input, idle, disconnected from viewers, or ended. Viewer connection state is separate from agent execution and task outcome. A hook reporting a completed turn changes activity to idle and keeps the PTY alive. A report from an agent does not automatically terminate a conversation. Existing delegated report/timeout behavior stays attached to delegated mode.

Conversation mode has no ordinary delegated-task idle timeout or automatic completion deadline. Explicit stop, resource failure and process exit remain observable. An unexpected exit preserves output and workspace and offers resume only when the adapter has a valid session identifier and resume support. A normal agent exit ends the conversation without claiming the work passed acceptance or was integrated. End session explicitly stops the agent, preserves changes and records the outcome without automatically accepting or merging them.

Waiting and idle conversations remain discoverable in active sessions. They must not be archived as settled tasks merely because a turn ended. Persisted live conversations retain their resource slot while the agent process lives; pacing uses those occupied slots and shows why another launch is queued. Provider limits prompt the user to wait, end, or explicitly start another session; no automatic conversation migration is introduced.

## Service and protocol boundaries

All clients use versioned operations/events. Introduce additive session creation and attachment operations, extending task/session read models with interaction mode, capability descriptors and activity state. Creation accepts repository identity, explicit workspace selection/base, executor preference, request text, claimed attachment IDs and an idempotency key. The service validates attachments, executor eligibility, checkout ownership and update admission before launching.

Creation returns a durable task/session ID even when queued. Persist attachment claims and task creation transactionally, with recovery for worktree/process setup failures. A repeated idempotency key with the same payload returns the same result; conflicting payloads return conflict. Revalidate eligibility and workspace ownership when dequeuing.

Attachment upload uses a dedicated authenticated streaming route with its own documented size limits, retaining existing Host, Origin, client-header and cookie protections. Ordinary JSON operations retain their existing body cap. API errors use CoreError; protocol and plugin schemas/docs are generated and freshness-tested. Client feature negotiation hides unsupported launch/delivery actions on older services.

Agent launch and attachment behavior belongs behind executor/plugin adapters; lifecycle and input control remain service coordinated. Credentials stay with the selected account's native configuration or existing secret references. User text and attachment names never become shell command strings. The UI imports service API and shared presentation vocabulary rather than host internals.

## Delivery sequence

1. Service conversation lifecycle, launch capability descriptors, explicit workspace semantics and protocol compatibility tests.
2. Private attachment transport/storage and adapter delivery contracts, with honest support descriptors.
3. Home composer and terminal-first working shell using the existing design system and lazy terminal bundle.
4. Live agent validation and documented capability matrix. Release support is limited to exercised agent/version/platform combinations; unsupported combinations have visible reasons.

These stages form one implementation plan with explicit dependencies. A durable lifecycle/plugin decision requires an ADR before shipping implementation.

## Validation and governance

Applicable constraints: ARCH-1–5/8–9/12–14; API-1–5; SEC-1–5/7–8; CT-11; UI-1–3/6/8–25; REPO-1–7. The constitution's adopted UI-19–25 requirements govern despite stale Proposed labels in scoped files. Reviewer scopes: architecture, protocol compatibility, security, QA and UI/accessibility. No policy amendment or exception is requested.

Test creation/idempotency, queue admission, competing checkout writers, conversation turn/report/exit behavior, reconnect/control transfer, retention and legacy delegated behavior. Test streaming limits, attachment ownership/claims/expiry, traversal, sandbox readability, cancellation/retry and launch failure recovery. Exercise native permission prompts without suppressing them in the new interactive launch mode.

Run typecheck, relevant/full tests, UI policy checks and builds within the existing 60 KB app and 150 KB terminal gzip budgets. Capture changed screens at 1440 px in light/dark and at 375 px. Verify keyboard/IME/focus, screen reader support and terminal shortcut conflicts. Provide implementer compliance and independent UI/accessibility and QA evidence as required by constitution 0.4.0.

Run the live harness with real supported agents: initial prompt, native tools/commands, permission interaction, pasted screenshot, picked/dropped file, later attachment, two conversation turns without termination, window close/reconnect, competing viewer, resize, worktree isolation, existing checkout conflict, explicit end and supported resume. Include native desktop and browser surfaces and record the harness evidence summary. Mark unexercised agent/version/platform features UNVERIFIED; do not claim completion while required behavior remains unverified.
