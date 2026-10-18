# Live validation harness

Status: Accepted by the maintainer, 2026-10-18 | Governance: CT-11 in `.project/rules/code-and-testing.md`

## Problem

Automated tests run against fakes, so a task can pass `bun run test` and still fail when a human uses pacer. Agents need a repeatable way to run the code under review the way a person would and to capture evidence. This covers the CLI, API, TUI, web app and tray popover, Orca panel and desktop shell, with real executors. A task is done only when that evidence exists.

## Decisions

| ID | Decision |
|----|----------|
| D1 | **Sandboxed service, real user tools.** The harness starts a second `pacer serve` from the checkout under test. It runs with a temporary `PACER_HOME` and a free `PACER_PORT`, never the user's `~/.pacer` or port 4317. `HOME` stays real, so real executors (Codex, OpenCode) keep their own auth and the usage readers see real readings. pacer only reads those paths. |
| D2 | **Real executors always.** Delegations in a live run use the installed executor CLIs and spend real budget. They run against a disposable git repo the harness creates inside the sandbox, never against the user's checkout. `PACER_BACKEND=direct` keeps runs out of the user's Orca. |
| D3 | **Guarded binary.** The sandbox puts a `pacer` wrapper first on `PATH`. It runs the checkout's `src/cli.ts` with the sandbox env, and refuses commands that would change the user's real environment: `install`, `uninstall`, `init`, `setup`, `statusline`, `service install/uninstall`, `plugin install/set`, `update`, `account add/rm/login`, `host setup`, `orca …`, and `open` without `--print`. It also sets `PACER_NO_UPDATE_CHECK=1`. |
| D4 | **Browser surfaces are driven by the agent's own browser tools.** Examples are Chrome DevTools MCP and Claude in Chrome. The harness prints a fresh single-use login URL from `pacer open --print`. It does not depend on Playwright. |
| D5 | **The TUI runs in tmux.** The harness starts `pacer dashboard` in a named tmux session with the sandbox env. Agents send keys and capture the screen as text through harness subcommands. The `u` (update) key is covered by the D3 guard. |
| D6 | **Desktop and Orca run as separate instances.** The desktop app is launched with the sandbox `PACER_HOME`, `PACER_PORT` and `PATH`, so its `pacer open --print` resolves to the sandbox. Agents drive it with computer-use tools. The Orca panel is checked in an isolated Orca profile, following the `scripts/e2e/orca-bootstrap.ts` pattern, never in the user's real Orca profile. Where that profile cannot be created, the agent checks the rendered panel HTML in a browser instead. |
| D7 | **Evidence is part of the result.** Each sandbox has an evidence folder under `.work/live/<id>/evidence/`, which is untracked. `report` writes `report.md` with the scenarios run, commands, observed output and screenshot paths, and a PASS/FAIL/UNVERIFIED verdict per changed behavior. The PR's "How tested" section summarizes it. |
| D8 | **Guard every network client.** A detached Bun.serve proxy owns the public `session.port = PACER_PORT`; `pacer serve --port <innerPort>` binds a second free loopback port while retaining the public `PACER_PORT` in its environment. The proxy refuses environment-changing operations on both API versions using the single exported `BLOCKED_OPS` policy, including every `service.*` except `service.status`. `setup.init` remains allowed because it only writes sandbox strategy and skips integrations. Refusals use HTTP 403 with `{error:{code:"forbidden",message:"Live validation D8: <op> changes the real user environment"}}` and append evidence notes. See the procedure's audited handler table. Host and matching public Origin are rewritten for upstream validation; cookies, assets, SSE streaming and session WebSockets pass through. |

## Interface

`bun run live <command>` runs `scripts/live/cli.ts`:

| Command | Effect |
|---------|--------|
| `up [--id <id>] [--repo-template <dir>]` | Creates `.work/live/<id>/` with `home/` (`PACER_HOME`), `bin/pacer` (the guard), `repo/` (a disposable git repo with one commit), `logs/` and `evidence/`. Picks two distinct free ports, starts `pacer serve` on the inner port and the guard proxy on the public port, verifies both identities and forwarded `/health`, writes `session.json` and `env.sh`, and prints the session JSON. |
| `env [--id]` | Prints `export` lines for the sandbox, for `eval`. |
| `pacer [--id] -- <args…>` | Runs the guarded pacer with the sandbox env. |
| `login [--id] [--screen <s>]` | Prints a fresh app login URL. |
| `tui start\|keys <keys…>\|capture [--out <file>]\|stop` | Controls the dashboard in tmux. A capture is saved to the evidence folder. |
| `desktop [--app <path>]` | Launches the desktop app with the sandbox env (macOS). |
| `orca [--print]` | Sets up an isolated Orca profile with the plugin and prints how to reach the panel. |
| `note <text>` / `attach <file>` | Records an observation or file in the evidence log. |
| `report [--id]` | Writes `evidence/report.md` from `evidence/log.jsonl`. |
| `status` / `down [--id] [--keep]` | Lists sandboxes, or stops the proxy, service and tmux and removes the sandbox (`--keep` keeps the evidence). |

`session.json` includes `innerPort` and `proxyPid` alongside the public `port` and service `pid`. The proxy logs to `logs/proxy.log`; all clients keep the public coordinates in `env.sh`, and no client uses the inner port. `healthy()` checks both identities; `down` checks and stops each process independently, including when the other has already exited.

The default `id` is the most recent sandbox. The sandbox state never leaves `.work/live/`.

## Procedure

[docs/testing/live-validation.md](../testing/live-validation.md) is the agent-facing procedure. It covers which surfaces to exercise for which changed paths, the evidence that is required, and how to report UNVERIFIED. `.claude/skills/live-validate/SKILL.md` is a thin wrapper that points to it.

## Out of scope

- Running in CI.
- Signing the desktop app.
- Changing pacer's runtime behavior. The harness only consumes existing flags and env vars (`PACER_HOME`, `PACER_PORT`, `PACER_BACKEND`, `PACER_NO_UPDATE_CHECK`, `open --print`).
