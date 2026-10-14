# Real-Orca bootstrap release check

Run this before releasing an Orca plugin, with Orca open and this repository registered as a worktree:

```sh
bun run plugin:build
bun run build
bun scripts/e2e/orca-bootstrap.ts --binary dist/pacer
bun scripts/e2e/orca-bootstrap.ts --binary dist/pacer --set-up
bun scripts/e2e/orca-bootstrap.ts --binary dist/pacer --path /usr/bin:/bin
```

The fresh case opens `init`; `--set-up` opens `dashboard`. The harness runs the real bootstrap code, real pacer binary and real Orca CLI. It supplies a temporary HOME to pacer, and the real HOME only to Orca. `--path` simulates an installation without agent CLIs or Orca on PATH. Orca resolution uses `ORCA_CLI_COMMAND`, PATH, then the installed macOS app CLI.

Every execution, notification, terminal output and final state is printed. The harness stubs pacer service install, uninstall and status; a temporary service fixture and shadow launchctl/systemctl executables also isolate init's internal service backend. It never registers, removes or restarts the user's real `com.pacer.serve` LaunchAgent. Agent configuration and panel files remain in the temporary HOME.

The standalone harness cannot call a plugin worker's host. It emulates `workspace.readContext` using the real worktree containing its CWD, with branch and displayName but no worktreeId, to exercise Orca 1.4.224 resolution. Use `--worktree <id>` to select another registered worktree explicitly. The production worker gets its focus from the real host.

Created terminals are closed and temporary files removed even on failure. `--keep` retains both for interactive inspection; remove them manually afterward. This harness is intentionally outside `bun test`.

## Sidebar visual check

Render standalone panels at Orca's 340 px sidebar width:

```sh
bun scripts/qa/render-panels.ts .work/fixtures/panels
```

An optional output-folder argument chooses another destination. The renderer writes twelve HTML files: light and dark versions of the static marketplace panel, incomplete setup with and without a console, operations without a console, operations with running and failed tasks, and operations with an available update. Fixtures use fixed timestamps and Orca-like theme variables; host actions are inert.

Open each file in a browser and check nothing overflows or sits outside its section. Check that the operations header precedes Setup and Updates, unknown versions hide Updates, the disabled bottom buttons stay in one row with one console reason, and setup shows one selectable `pacer init` block above required and optional checklist groups. In the operations fixtures with a console, use Delegate a task and Strategy to inspect those views too. Check both themes and resize the browser to at least 340 px; the panel body stays fixed at 340 px. Generated files stay under `.work/` and must not be committed.
