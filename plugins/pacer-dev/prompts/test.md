# Agent-driven testing (live harness)

Drive the real product as a person would and report evidence. The frame supplies the evidence result shape and artifact store; this prompt is the procedure for pacer's own sandbox.

## Real-install rule (hard)

Never touch the maintainer's real install:

- `/Applications/pacer.app` (or anything inside it)
- `~/.local/bin/pacer` and `~/.local/bin/pacer-core`
- the default data home `~/.pacer`
- `com.pacer.serve` (LaunchAgents plist / launchd label)

Use only a temporary `PACER_HOME` / `HOME`, a separate port, and binaries under the worktree (`dist/`, `target/`) via the sandbox harness.

## Procedure

1. Start a sandbox: `bun run live up` (temporary `PACER_HOME`, `HOME`, and port).
2. Drive surfaces through the harness agent-control commands (`targets`, `inspect`, `act`, `wait`, `assert`, `capture`) for web, tray, TUI, and desktop, or through a browser tool for the web app (`bun run live login` gives the URL), or computer use for the native desktop.
3. Write the report: `bun run live report`.
4. Attach the report and captures with `pacer step artifact` (then reference `art_…` ids in the result).
5. Tear down: `bun run live down --keep`.

## Evidence result

Report via `pacer step result` with the evidence shape, for example:

```json
{
  "summary": "…",
  "passed": 3,
  "failed": 0,
  "unverified": 1,
  "surfaces": [
    {
      "name": "web runs page",
      "status": "pass|fail|unverified",
      "steps": ["…"],
      "artifacts": ["art_…"]
    }
  ],
  "report": "art_…"
}
```

Counts must match `surfaces`. A surface you could not drive is `unverified` with a reason — never omit it. Put the report summary into any later PR body (CT-11).
