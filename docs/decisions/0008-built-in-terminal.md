# 0008: Service-owned built-in terminal

Date: 2026-10-26

Status: Accepted for implementation

## Context

Pacer's app can show agent sessions, but general shell commands and several settings actions still open an external terminal. That makes the app dependent on an OS terminal for routine work and splits terminal state across products.

## Decision

`pacer serve` owns detached interactive PTYs and a private terminal registry under `PACER_HOME`. The app exposes shell tabs, splits and search. Additive v3 operations manage terminal records; a same-origin authenticated WebSocket reuses the task-session framing, replay and exclusive input control. Browser callers may create login shells only. Trusted service actions supply their own argument vectors to the internal launcher and return a terminal ID for app navigation. The CLI and TUI retain their existing external launch targets.

Each creation has a request ID reserved before spawn. A repeat request reuses the record or reports a conflicting payload. The API never accepts arbitrary command text or argv for actions; users type commands into an authenticated shell stream. Terminal files are private, and executor work grants cannot manage or attach to these terminals.

The Rust client schema generator emits terminal and host-terminal operation types into the `pacer-terminal-protocol` area crate. This keeps the core generated client crate within CRATE-3's 10,000-line limit.

## Consequences

Terminal processes survive closing an app window and reconnect through the service. Closing a live tab stops its PTY after confirmation. Service lifetime, registry cleanup and terminal limits become service responsibilities. Configured-host SSH uses a noninteractive, time-bounded connection recipe in the app; remote login behavior needs separately authorized live validation.
