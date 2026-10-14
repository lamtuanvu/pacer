# Changelog

Notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Releases from 0.1.15 on are published on GitHub Releases, npm and Homebrew.

## [Unreleased]

## [0.1.22] - 2026-10-14

- Make `pacer init` the complete, consent-based setup flow with planner selection, agent connections and live panel guidance; `setup` is an alias.
- Open setup or dashboard in the focused Orca worktree once per launch, and retire marketplace automation when the live panel connects.
- Add a live heartbeat and a real-Orca bootstrap release harness.

## [0.1.21] - 2026-10-14

### Added

- Cached, opt-out update checks for the CLI and Orca plugin, with version-aware notices and plugin update instructions.
- Live panel update controls and dashboard keys `c` (check) and `u` (update with confirmation).

### Changed

- `pacer update --check --json` reports current/latest versions and installed plugin status without installing anything.

## [0.1.20] - 2026-10-14

### Fixed

- Marketplace installs open the pacer terminal again. 0.1.19 looked for an Orca session id that the plugin worker never has, so the dashboard never opened; it now keys on the Orca app process.

### Changed

- The marketplace setup panel always lists the manual setup commands (install script, `pacer setup`, `pacer dashboard`) under "Setup not finishing?", and opens them after two minutes. Failure notifications point there.
- If Orca can't open the pacer terminal, the plugin now says pacer is running and how to open the dashboard, instead of reporting that pacer couldn't start.

## [0.1.19] - 2026-10-13

### Added

- `pacer dashboard`: live terminal budgets, ranked executors, attention groups and tasks, with keyboard delegation, retry, stop, focus, dismiss, blocking and strategy switching.

### Changed

- Marketplace installs open the dashboard in a **pacer** terminal once per Orca session instead of requiring a manual development-folder handoff. The sidebar folder is still prepared as an optional alternative.
- The static bootstrap panel shows installation progress and elapsed time, dashboard reopening instructions and collapsed sidebar setup steps.

## [0.1.18] - 2026-10-13

### Changed

- `pacer update` refreshes the managed Orca plugin folder.
- The marketplace setup panel shows an activity indicator with elapsed time, and a hint to check the install after two minutes.

### Docs

- Explain how to get marketplace and development-folder plugin updates.

## [0.1.17] - 2026-10-13

### Fixed

- Marketplace installs no longer modify Orca's integrity-checked plugin folder.

### Changed

- A static bootstrap panel and persisted progress notifications install and start pacer, prepare the managed development folder automatically, then show the one-time Orca settings steps for the live budget panel.
- `pacer plugin install` writes a versioned marker and prints the one-time Orca steps; `pacer plugin status` reports marketplace and development copies.

## [0.1.16] - 2026-10-13

### Added

- The Orca plugin installs pacer itself: it downloads the checksum-verified binary for its own version, creates a starter strategy and installs the login service, then keeps the service running and the binary in step with the plugin.
- A live setup checklist in the plugin (install, start, connect) and a one-click **Connect my agents** button, backed by the new `pacer setup` command. Agent configuration is only changed after that click.

### Fixed

- Orca workers stuck on a provider's "model at capacity" message are resent the task with backoff and then handed to the next executor; workers idle without progress are nudged, then failed.

## [0.1.15] - 2026-10-13

### Added

- First public release: Apache-2.0 license, community policies, contribution guidance, GitHub templates, user documentation, design system and roadmap.
- Release pipeline: binaries for macOS and Linux on GitHub Releases with checksums and build provenance, `install.sh`, npm (`@lamtuanvu/pacer`) and Homebrew (`lamtuanvu/tap/pacer`).
- Orca plugin published as `lamtuanvu.pacer`, installable from the pacer repository as a marketplace source.

### Changed

- `pacer update` refreshes agent integrations, and points npm and Homebrew installs to their package manager.
- Install summaries report Claude MCP changes.

## [0.1.14] - 2026-10-13

- Made the CLI and installed skill the primary agent interface, with optional MCP.
- Cleared resolved Needs attention cards and added task-session focus actions.

## [0.1.13] - 2026-10-13

- Added per-task current/new/auto worktree placement with safety vetoes.

## [0.1.12] - 2026-10-13

- Fixed acceptance pipeline failure handling, needs-review outcomes, duplicate retries and requested-executor fallback.

## [0.1.11] - 2026-10-13

- Fixed notification level control without unsupported panel settings calls.

## [0.1.10] - 2026-10-12

- Fixed agy launch arguments, broken-executor fallback, attention lifecycle and Orca coordinator recovery.

## [0.1.10-hotfix.1] - 2026-10-12

- Published each task alert once to prevent notification storms.

## [0.1.9] - 2026-10-12

- Showed unchanged panel snapshots as updated rather than stale.

## [0.1.8] - 2026-10-12

- Added launchd/systemd service management and restart on update.

## [0.1.7] - 2026-10-12

- Opened a pacer console automatically in the focused Orca worktree.

## [0.1.6] - 2026-10-12

- Added agent-built strategies through MCP tools, CLI commands and the panel builder.

## [0.1.5] - 2026-10-12

- Made panel action buttons equal in height.

## [0.1.4] - 2026-10-12

- Redesigned the Orca budget panel.

## [0.1.3] - 2026-10-12

- Refused release builds with stale generated plugin assets.

## [0.1.2] - 2026-10-12

- Added the Orca plugin, console and brain link.

## [0.1.1] - 2026-10-12

- Added guard event IDs for decision feedback.

## [0.1.0] - 2026-10-12

- Established budget readers, active-hour pacing, routing, task delegation and planner integrations.
- Added the CLI/MCP interfaces, classifiers, benchmarks and checksum-based release build/update tooling.
