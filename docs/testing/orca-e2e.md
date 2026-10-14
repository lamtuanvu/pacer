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
