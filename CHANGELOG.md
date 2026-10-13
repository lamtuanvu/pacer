# Changelog

Notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Releases from 0.1.15 on are published on GitHub Releases, npm and Homebrew.

## [Unreleased]

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
