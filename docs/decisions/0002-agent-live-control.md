# Agent control and desktop self-capture

Date: 2026-10-21
Status: design approved; native live validation remains required before completion.

## Context

[#239](https://github.com/lamtuanvu/pacer/issues/239) needs agents to operate and
observe native UI during live validation. The approved
[design](../specs/2026-10-21-agent-live-control-design.md) expands that to a shared
CLI for web/tray, TUI and desktop. Self-capture must ship in normal releases.

## Decisions

1. Extend the existing live harness with typed JSON commands and surface
   adapters. Use the existing Playwright dependency with a dedicated Chromium
   context, tmux for terminal control and a macOS Swift AX/ScreenCaptureKit
   helper for external native observation. No planner-specific tool is required.
2. The harness owns leases, target generations and evidence; it does not become
   a production service subsystem. Product mutations retain API ownership.
   The desktop shell owns intrinsic window capture. The service only brokers
   authenticated requests and bounded artifacts. This keeps OS APIs outside
   domain core and does not create a built-in replacement for an extracted
   plugin. Future alternative providers must follow ARCH-12–14.
3. Normal desktop registration optionally requests a per-instance capture-worker
   credential. The desktop polls requests over its existing authenticated
   session and reports its exact owned window IDs. There is no new production
   listener, arbitrary-window capture or remote output path.
4. Keep the normal JSON body limit of 256 KiB. Transfer PNGs through authenticated
   binary routes capped at 16 MiB, with dimensions at most 16,384 pixels per
   axis. Requests expire after 60 seconds; completed images expire after 30.
   Limit outstanding capture requests to 16 and live workers to 64.
5. Use kernel file locks for target ownership and a shared desktop lease across
   worktrees. A late heartbeat never authorizes stealing a live lease. Kernel
   release on process exit avoids ambiguous stale-lock reclamation.
6. Store images, observations and source/binary provenance under untracked
   `.work/live/`. Preserve action delivery even if subsequent observation fails.
   Never automatically repeat uncertain mutations. Replay uses the same typed
   commands; captures without assertions cannot establish PASS.
7. Desktop window capture uses ScreenCaptureKit; content capture uses
   WKWebView snapshots. Weak-link ScreenCaptureKit to preserve the shell's
   existing deployment floor, and report unsupported APIs at runtime.
   Availability on the oldest supported OS still requires release validation.
   External capture is labeled and retains the reason self-capture failed.
8. Native operation requires an exclusive desktop session. A separate existing
   Pacer singleton is not taken over or terminated by the harness. Accessibility
   and capture permission are diagnosed, never granted automatically. Actual
   VoiceOver observation must first pass known-good calibration; accessibility
   text and generated speech cannot substitute for that evidence.

## Consequences and evidence

The browser worker persists between CLI commands and uses an authenticated,
private Unix socket. Browser and TUI control can run without native Accessibility
permission. Native APIs compile on the measured macOS 27.0/Xcode 27.1 host;
compilation does not establish native interaction, paint or VoiceOver usability.
Missing native prerequisites remain UNVERIFIED under CT-11. Browser/TUI live
evidence cannot waive native/manual obligations.

macOS captures remain distinct from browser screenshots. Native menus and
popovers may be separate windows, and a content snapshot excludes native chrome.
VoiceOver automation and reliability gating require their own measured evidence;
this ADR does not amend UI-2 or enable privileged unattended CI.
