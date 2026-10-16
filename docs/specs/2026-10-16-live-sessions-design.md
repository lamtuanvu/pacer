# Live executor sessions: watch and drive a delegated task's terminal

Status: proposed 2026-10-16. Builds on the [core contract](2026-10-14-core-contract-design.md) (protocol v2), [remote runners](2026-10-14-remote-runners-design.md) and [the pacer app](2026-10-15-pacer-app-design.md). Design only; nothing here is implemented yet.

## Why

A delegated task runs for minutes to hours. Today the only way to see what it is doing is the opt-in `orca` backend (`execution.backend: orca`): the agent runs in an Orca terminal and `focus` switches to it. Every other run is invisible until it ends:

- The default, `execution.backend: auto`, runs every task on pacer's own direct backend, local or remote. Even with `orca` selected, `selectBackend` (`src/exec/backend.ts`) forces the direct backend for non-default accounts and endpoint executors.
- A direct run is a file-backed wrapper (`src/supervisor/wrapper.ts`). It writes `stdout`, `stderr` and `exit` into `PACER_HOME/runs/<task>/<attempt>/`. `task.log` reads them by byte offset, and `finishRun` (`src/exec/direct.ts`, around line 123) writes the legacy `<task>.<executor>.log` only at the end.
- Without a terminal, agents print their non-interactive output: plain text, often nothing until the final answer.

Users want to watch a task live, and sometimes step in. That might mean answering a question, stopping a loop or nudging the agent. They want to do it from Orca, their own terminal (iTerm, Ghostty, tmux, over SSH) or the pacer app.

pacer must not build an agent UI to get there. The agent draws its own UI in a real terminal. pacer only moves bytes.

## Prior art: how Orca does it

Orca (MIT, [stablyai/orca](https://github.com/stablyai/orca)) already solved this for its own terminals. We read its source at commit `224a139d` before designing, so we reuse the patterns that work rather than invent new ones.

| Concern | Orca | pacer (this design) |
| --- | --- | --- |
| PTY owner | A detached terminal daemon, separate from the Electron app; survives app restarts and updates (`src/main/daemon/`) | A detached **session host** per attempt; survives runner, `pacer serve` and viewer restarts |
| PTY library | node-pty 1.1.0 with a local patch | `Bun.Terminal`; no native module |
| Late attach | A headless xterm (`@xterm/headless` + `SerializeAddon`) per PTY. Attach returns a serialized snapshot plus an absolute output byte count, then live bytes, all in one synchronous step | Same model |
| Recording | Per session: `checkpoint.json` plus a framed `output.log` (length-prefixed output/resize frames), 5 MB cap and then a checkpoint, 0600 files in 0700 directories | Same model, with pacer's own caps |
| Viewers | One client per session at the daemon; the app fans out to renderer, CLI and phones | The session host fans out itself, because `pacer attach` must work without `pacer serve` |
| Input | No read-only mode; one size "driver" at a time (the most recent mobile actor) | Read-only by default; one controller at a time, who also sets the size |
| Slow viewers | Pause reading the PTY for the client; resync from a snapshot when the 2 MB pending buffer overflows | Never pause the agent for a viewer; resync the slow viewer from a snapshot |
| Agent status | Hooks POST to a localhost server (Claude: tool use = working, permission = waiting, Stop = done); titles are a fallback; completion is an explicit `worker_done` command; results come from the agent's own transcript | Same approach for interactive mode (phase 4); headless mode keeps exit codes |
| Remote hosts | Deploys its own server (orcad) **and its own pinned Node** to the host, then tunnels a WebSocket over SSH. Remote PTYs live in a detached daemon on the host | Phase 5: `script(1)` recording first; later, upload the pacer binary and run the same session host there |
| Secrets in output | No redaction; file modes only | File modes, plus exact-value masking of credentials pacer injected itself |

Two Orca lessons shape this design:

- **Never scrape the screen for state.** Orca's daemon answers terminal colour queries itself, and reads agent status from hooks and transcripts. It scans the screen only to tell when an agent is ready for its first prompt. pacer's `orca` backend detects idle prompts with a regex today (`IDLE_PROMPT` in `src/exec/orca/wait.ts`); this design does not extend that approach.
- **Snapshot plus byte sequence makes attach exact.** Replaying a raw log from byte 0 is slow and breaks once the log rotates. A serialized screen tagged with the output offset it covers lets a viewer join at any time without gaps or duplicates.

## Decisions

1. **Session host.** Each local attempt runs under `pacer _session <run-dir>`, a hidden subcommand of the same binary. It replaces the `sh` wrapper for PTY runs and keeps the wrapper's file contract (`pid`, `started`, `child`, `exit`, `stdout`, `stderr`), so `readRun`, `stopRun`, `supervise` and `resumeAttempt` work unchanged.
2. **PTY library: `Bun.Terminal`.** It ships in the Bun pacer already requires (`engines.bun >= 1.4.2`) and runs on macOS and Linux, the four release targets. It needs no native module in the `bun build --compile` release.
3. **Recording.** `session.log` in the run directory is a framed byte log, with checkpoints from a headless xterm. The session host also derives the plain-text `stdout` that existing readers use.
4. **Attach protocol.** One framed protocol on a Unix socket owned by the session host. `pacer serve` bridges it to a WebSocket for the app. `pacer attach <task>` speaks it directly from any terminal. The Orca plugin opens an Orca terminal that runs `pacer attach`.
5. **Read-only by default.** At most one controller. Taking control is explicit, and stealing it notifies the previous holder.
6. **Headless in a PTY first; interactive TUIs per runner later.** Interactive completion comes from an explicit report command and agent hooks, never from the screen.
7. **Remote hosts.** Read-only recording first, under util-linux `script(1)` (the package that provides the `setsid` hosts already need), mirrored over the existing SSH ControlMaster. Full sessions on hosts come later, by uploading the pacer binary, as Orca does with its server.

## Architecture

```
                         PACER_HOME/runs/<task>/<attempt>/
 pacer _run <task>       ┌──────────────────────────────────────────┐
 (runner, supervise) ──► │ pid started child exit argv stdin        │ ◄── readRun / stopRun (unchanged)
                         │ stdout  stderr   (plain text, derived)   │ ◄── task.log, detectLimit, report
                         │ session.log  session.ckpt  (recording)   │ ◄── offline replay
                         │ session.sock (or a pointer file)         │
                         └───────────────▲──────────────────────────┘
                                         │ writes
                    ┌────────────────────┴───────────────────┐
                    │ pacer _session <run-dir>  (detached)   │
                    │  Bun.Terminal ── agent CLI (PTY child) │
                    │  @xterm/headless (snapshot, plain text)│
                    │  Unix socket server: viewers, control  │
                    └──▲──────────────▲──────────────▲───────┘
                       │              │              │
           pacer attach <task>   pacer serve       Orca terminal
           (iTerm/Ghostty/tmux,  /v2/tasks/<id>/   running
            over SSH)            session (WS) ──►  pacer attach <task>
                                 app xterm.js view
```

Lifecycle:

1. `runAttempt` writes `argv` and `stdin` as today, then starts `pacer _session <run-dir>` in place of `/bin/sh run.sh` in `startRun` (`src/supervisor/run.ts`). The process is detached into its own session, and its pid goes in `pid`.
2. The session host writes `started`. It spawns the agent with `Bun.spawn(argv, { terminal: { cols, rows, name: "xterm-256color", data } })` and writes the child pid to `child`.
3. Every PTY chunk is appended to `session.log`, fed to the headless xterm, normalized into `stdout`, and sent to every attached viewer.
4. When `proc.exited` resolves, the host writes `exit` (atomically: `exit.tmp` then rename), flushes, sends an `exit` frame to viewers, closes the socket and exits. `Bun.Terminal`'s own `exit` callback reports the PTY stream closing, not the process exit, so the host relies on `proc.exited` only.
5. On SIGTERM, SIGINT or SIGHUP, the host forwards SIGTERM to the child's process group, waits, and records 143, matching the wrapper's `on_term`. `stopRun` and `killTree` stay as they are.

`wrapperAlive` (`src/supervisor/run.ts`) currently matches `run.sh` in the process command line. It must also accept `_session <run-dir>`. The remote `REPORT` and `STOP` scripts keep matching `run.sh` until phase 5.

## 1. The local PTY

| Option | macOS + Linux | Release build | Attach, input, resize | Verdict |
| --- | --- | --- | --- | --- |
| **`Bun.Terminal`** (`Bun.spawn({terminal})`) | Yes (POSIX only) | No change: pure Bun, same `--compile` for all four targets | pacer owns the master: write, resize, raw bytes | **Chosen** |
| Native module (node-pty, or a small Zig/C addon) | Yes | A prebuilt `.node` per target must be embedded and extracted at run time, which breaks the single-file, cross-compiled release in `scripts/release/build.ts`. Orca needs a local node-pty patch to close fds correctly | Full | Rejected: release cost, and Bun already provides it |
| `script(1)` locally | BSD `script` on macOS and util-linux `script` on Linux have different flags (`-F` vs `-f`, `-c` exists only on Linux) | No change | Recording only. No attach socket, no resize from a viewer, no safe way to inject input | Rejected locally; used on remote hosts for read-only (phase 5) |
| tmux or dtach as the host | Extra dependency (tmux is not on stock macOS) | No change | tmux: full, but the user's `.tmux.conf`, nested tmux and global key bindings leak into sessions. dtach: attach only, no recording or snapshot | Rejected. `pacer attach` works inside tmux anyway |

Two checks before phase 1 (phase 0 spike):

- `Bun.Terminal` works in the compiled binary on all four targets: the release dry run builds them, and CI runs `ubuntu-latest` and `macos-latest`.
- `@xterm/headless` and `@xterm/addon-serialize` (pure JavaScript, what Orca uses) bundle into the compiled binary.

If `Bun.Terminal` is unavailable at run time, the session host falls back to the current pipe wrapper, and the task reports `session.kind: "none"`. A run never fails because a PTY is missing.

Prompt delivery stays as it is today. The session host runs the agent through `/bin/sh -c 'exec "$@" < "$1"'`, so stdin comes from the run directory's `stdin` file (Codex `exec -`) or argv (the others), while stdout and stderr are the PTY.

- Agents see a TTY on stdout and stderr, so they colour and stream their progress.
- An agent that reads its prompt from stdin still gets EOF, without anyone typing `^D`.
- Ctrl-C from a controller still interrupts. The PTY line discipline turns `\x03` written to the master into SIGINT for the foreground process group, wherever stdin points.

Terminal queries: a TUI that asks the terminal something (DA1, OSC 10/11 colours) and gets no answer can stall. When no controller is attached, the session host answers DA1 and OSC 10/11 with fixed defaults, as Orca's PTY owner does. When a controller is attached, its terminal answers. Replies from read-only viewers are dropped with the rest of their input.

## 2. Keeping structured signals apart from the terminal stream

A PTY merges stdout and stderr and adds escape sequences. Each signal pacer relies on today keeps working as follows:

| Signal | Today | With a session host |
| --- | --- | --- |
| Exit code, timeout, stop | `exit` file written by the wrapper; `supervise` polls `readRun` | Same file, written by the session host |
| Limit detection (`detectLimit`, `src/exec/limits.ts`) | Regexes over the last 8,000 chars of `stderr + stdout` | Runs over the derived plain-text `stdout`. It already concatenates both streams, so merging changes nothing for it |
| Report text | Tail of `stdout`, or Codex's `-o` last-message file | Codex: unchanged (`lastMessageFile` is written by Codex, not the terminal). Others: tail of the derived `stdout` |
| Progress (`progressPoller`, `src/supervisor/progress.ts`) | `logBytes = stdoutBytes + stderrBytes`; `lastOutputAt` from file mtimes; git status every 30 s | The size and mtime of the derived `stdout` drive both, so `logBytes` counts real text, not redraws. Git probes are unchanged |
| `task.log` op and `GET /v2/tasks/<id>/log?follow=1` | Byte offsets into `stdout`/`stderr` | Unchanged; they read the derived plain text. The live view is a separate stream |
| Legacy `<task>.<executor>.log` | Written once at the end in `finishRun` | Unchanged. It now holds the plain-text transcript |

How the session host derives plain text:

- It strips CSI, OSC and DCS sequences with a small streaming state machine that holds a partial escape at a chunk edge until the next chunk.
- It turns `\r\n` into `\n`, and applies a bare `\r` (spinner overwrite) only to the current line.
- It writes completed lines to `stdout`. `stderr` stays empty for PTY runs. Readers already treat an empty file as zero bytes.

This plain text is reliable for line-oriented output: headless agents, `codex exec` progress, shell tools. A full-screen TUI redraws in place, so its plain text is noise. That is why interactive mode (section 3) takes its structured results from hooks and transcripts, not from `stdout`.

The idle rule depends on the mode:

- **Headless:** `lastOutputAt` comes from the derived text, so a spinner that only redraws does not count as output.
- **Interactive:** it comes from hook events and git changes (section 3).
- **While a controller is attached,** the idle-fail timer pauses. A human at the keyboard is not an idle task.

## 3. Headless in a PTY first, interactive TUIs later

**Headless (phases 1–3).** Each agent keeps the launch in `launchFor` (`src/exec/launch.ts`): `codex exec`, `claude -p`, `cursor-agent -p`, `agy -p`, `opencode run`. These modes exit on their own, so the exit code stays the completion signal and nothing about task state changes. How much there is to watch varies by agent: some stream progress, while `claude -p --output-format text` prints nothing until its answer. The phase 0 spike records what each launch shows in a PTY, and the docs say so plainly.

**Interactive (phase 4, opt-in per runner).** The runner config gains `session: interactive`. The agent starts its normal TUI, with the brief delivered as the first prompt (argv where the CLI accepts one, as Orca does for Claude, Codex and cursor-agent). That is the experience people get in Orca or their own terminal. A TUI never exits on its own, so completion comes from signals, in this order:

1. **Explicit report (authoritative).** The brief tells the agent to run `pacer report --task <id> --outcome done|failed --summary "<3 sentences>"` exactly once, like Orca's `worker_done`.
   - The command writes `report.json` into the run directory, which `PACER_RUN_DIR` points to in the child's environment.
   - The session host then ends the TUI: it sends the agent's exit command if one is configured, otherwise SIGTERM, and finally SIGKILL after a grace period.
   - The task outcome comes from `report.json`, not the exit code.
2. **Hooks (status).** The session host gets agent hooks for this launch only; it never edits the user's global agent settings.
   - Claude: `claude --settings <run-dir>/hooks.json`.
   - Codex: its hooks file in a per-run config overlay, if Codex supports one; otherwise Codex stays headless.
   - The hooks append events to `<run-dir>/events.jsonl`, using Orca's mapping (tool use or prompt submit = working; permission request = waiting; Stop = turn ended).
   - A `waiting` status raises an alert, "Task needs input: attach to answer". That links interactive mode to take-control.
3. **Turn ended without a report.** After a Stop hook and 120 s with no report, no activity and no controller, the task is marked `needs-input`, not failed, and an alert is sent. The user can attach and answer, or stop the task.
4. **Process exit.** Exiting without a report counts as failure (the exit code is kept), unless the exit was pacer ending the TUI after a report.

The report text comes from the agent's transcript when the hook gives a `transcript_path` (Claude JSONL; Codex session files): the last assistant message. Otherwise it comes from `report.json`. The terminal is never parsed.

The headless default stays, because it is the only mode with a guaranteed end, and pacer's routing and limit handling depend on attempts ending.

## 4. Session files, retention, size and secrets

### Format

`session.log` is a framed binary log, modelled on Orca's `output.log`:

```
header: "PACERTTY" u8 version=1  u32 header-json-length  header-json
        header-json = {"cols":120,"rows":40,"startedAt":<unix s>,"generation":0}
frame:  u8 type  u32 ms-since-start  u32 length  bytes
        type 1 output   (raw PTY bytes)
        type 2 resize   (u16 cols, u16 rows)
        type 3 marker   (JSON: attach / detach / control-taken / control-released, with client label)
        type 4 input    (controller keystrokes; off by default, see Secrets)
```

- Frames carry timing, so `pacer attach --replay` and an exported asciicast (`pacer attach <task> --export cast`) can play a session back at real speed.
- A torn last frame, left by a crash mid-write, is truncated on read.
- The absolute output offset (total bytes of type-1 frames since the attempt began) is what snapshots and viewers use to line up.

`session.ckpt` holds the latest checkpoint as JSON:

- `{ generation, outputOffset, cols, rows, scrollbackAnsi, screenAnsi, modes }`
- It is produced by `SerializeAddon` from the headless xterm and written atomically (tmp file, then rename).

### Size and rotation

- The default cap for `session.log` is 8 MiB per attempt (setting `execution.session_log_mb`, range 1–256).
- When the log reaches the cap, the host writes a checkpoint, renames the log to `session.log.1` (replacing the previous one) and starts a new generation. One attempt therefore uses at most about 2 × cap plus one checkpoint.
- Offline replay restores the checkpoint, then plays the current log.
- Scrollback in the headless xterm is 5,000 rows (Orca's default). The checkpoint includes it, so a late viewer can scroll back that far.

### Retention

- **Local.** `pacer clean` (`clean` in `src/core/tasks.ts`) deletes `runs/<task>` only for settled, reviewed, dismissed or resolved tasks that ran in a new worktree. Tasks that ran in place keep their run directories forever.
  - The change: `pacer clean` also removes `session.log*` and `session.ckpt` for settled tasks that ran in place and were reviewed, dismissed or resolved. It keeps the small plain-text `stdout`, `stderr` and `exit`, so `task.log` keeps working.
  - A new periodic job in `pacer serve` (beside its existing pump and snapshot timers) prunes `session.*` files of settled tasks older than `execution.session_retention_days` (default 14).
- **Remote.** `pacer host clean` (`clean` in `src/remote/hosts.ts`) already runs `SCRIPTS.CLEAN`, which `rm -rf`s the whole remote run directory. Session files live in that directory, so nothing is added. The local mirror follows the local rules above.

### Permissions

The session host creates `runs/<task>` and its attempt directory with mode 0700 (today they use the `mkdirSync` default), and the session files and socket with 0600. `startRun` already writes `stdin` as 0600.

### Secrets

A terminal recording holds whatever the agent printed. Orca does not redact recorded output. pacer goes slightly further, only where it can be exact:

- **Exact-value masking.** The session host knows the credentials pacer itself put into the child environment: endpoint keys from `runnerEnv` (`src/exec/launch.ts`) and secrets from `PACER_HOME/secrets`.
  - It replaces each value of 8 or more characters with `****` in `session.log`, in the derived `stdout` and in the live stream.
  - Matching keeps a tail buffer as long as the longest secret, so values split across chunks are caught.
- **No heuristic redaction.** Guessing at "things that look like keys" in a terminal stream is unreliable, and would give a false sense of safety. The docs say plainly that the recording can contain secrets the agent prints, such as `cat .env`.
- **Controller input is not recorded.** Input frames are off by default (`execution.session_record_input: false`), because a person may type a password. Typed characters echoed by the terminal do appear in the output, as in any terminal; no-echo prompts stay hidden.
- **Access.** The session socket is 0600 in a 0700 directory. The WebSocket bridge needs the same auth as every `/v2` route: a bearer token, or the app cookie with the Origin checks from the app spec. The app's Content-Security-Policy is unchanged. Rendering stays in xterm.js, so no recorded bytes are ever inserted into the page as HTML.

## 5. Protocol changes

### Session socket (session host ↔ any client)

Socket placement:

- The socket is `run-dir/session.sock` when the path fits `sun_path` (104 bytes on macOS).
- Otherwise it is `$TMPDIR/pacer-<uid>/<sha256(run-dir)[:12]>.sock`, and `run-dir/session.sock.path` holds that path. This is Orca's fallback.
- The client must be the same uid (checked with `getpeereid`/`SO_PEERCRED` where Bun exposes it; the 0600 mode is the baseline).

Framing: `u8 type, u32 length, bytes`. Binary types carry terminal bytes; JSON types carry control messages.

| Direction | Type | Body |
| --- | --- | --- |
| client → host | `hello` (JSON) | `{ v: 1, client: "cli" \| "app" \| "orca", label, cols, rows, from?: outputOffset }` |
| host → client | `snapshot` (JSON) | `{ outputOffset, cols, rows, scrollbackAnsi, screenAnsi, controller: label \| null, viewers }`, taken and sent in the same tick as the client joins the fan-out, so no bytes fall between snapshot and stream |
| host → client | `output` (binary) | Raw PTY bytes after masking. The client tracks the offset |
| host → client | `resize` (JSON) | `{ cols, rows }` when the controller resizes |
| host → client | `control` (JSON) | `{ controller: label \| null, you: boolean, reason?: "taken" \| "released" \| "disconnected" }` |
| host → client | `resync` (JSON) | Sent before a fresh `snapshot` when this client fell behind (section 6) |
| host → client | `exit` (JSON) | `{ code, signal? }`; the host closes the connection afterwards |
| client → host | `take` / `release` (JSON) | `{ force?: boolean }` |
| client → host | `input` (binary) | Keystrokes; dropped unless the sender is the controller |
| client → host | `size` (JSON) | `{ cols, rows }`; applied to the PTY only from the controller |

A client that sends `from` with an offset the host still has gets the missing bytes instead of a snapshot. This is how the WebSocket bridge resumes after a brief network drop.

Offline sessions (the session host has exited, or the run is remote and not live) are read by the client straight from `session.ckpt` and `session.log*`. The same `snapshot` plus `output` frames are synthesized locally, followed by `exit`.

### v2 API (`src/api/`)

The protocol moves from 2.0.0 to 2.1.0 (additive). `docs/protocol.md` is regenerated with `bun run protocol:doc`.

- **`task.session` op:**
  - Takes `{ id }` and returns `{ kind: "pty" | "orca" | "none", live, host: string | null, cols, rows, controller: string | null, viewers, attach: { cli: "pacer attach <id>", ws: "/v2/tasks/<id>/session" } }`.
  - `kind: "orca"` means the task runs on the `orca` backend; attaching it switches to its Orca terminal (today's `focus`).
- **`GET /v2/tasks/<id>/session`:**
  - A WebSocket upgrade on the existing `Bun.serve` in `src/serve/http.ts`, with the same Host, bearer and cookie rules as the rest of `/v2`. Cookie clients also need the same Origin and `Sec-Fetch-Site` checks that non-GET requests get, because browsers do not preflight WebSockets.
  - The bridge relays session-socket frames unchanged in both directions: binary WebSocket messages carry binary frames, text messages carry JSON frames.
  - It does not interpret the stream. It only tags `hello.client`, so the app cannot pose as `cli`.

### Link envelope (`src/link/envelope.ts`)

- **`TaskData.session?`** is `{ kind: "pty" | "orca" | "none"; live: boolean; controller: string | null; viewers: number }`, parsed with the same clipping helpers as the other fields (labels up to 64 chars, viewers up to 99). The pump publishes it with the task and throttles changes to one per second.
- **`terminalPresent`** stays for one minor release, set to `session.kind === "orca" && session.live`, so an older Orca plugin keeps working.
- **New `attach` command.** It is added to `CMD_NAMES`, with `taskId` required.
  - For `kind: "pty"`, the console runs `orca terminal create --worktree <task worktree> --title "pacer <id>" --command "pacer attach <id>"`, the same pattern `open-terminal` uses (`src/console/console.ts`).
  - For `kind: "orca"`, it does what `focus` does now: `orca terminal switch`.
- **`focus`** remains as an alias of `attach` for one minor release.
- **`open-terminal`** keeps its current meaning (settings commands).

All three surfaces then attach the same way: the app over the WebSocket, Orca and any terminal through `pacer attach`, and the TUI dashboard's Focus action becomes **Attach** for every task with `session.kind !== "none"`.

### `pacer attach <task>` (new CLI)

```
pacer attach <task> [--control] [--replay] [--export cast] [--attempt <n>]
```

- **Viewing.** It puts the local terminal in raw mode, draws the snapshot, then streams. It sets the window title to `pacer <id> · <executor> · watching`. It works the same in iTerm, Ghostty, Terminal.app and tmux, and over SSH to the machine running pacer.
- **Keys when read-only.** `q` or `Ctrl-C` detaches; `c` asks for control.
- **Keys when in control.** Everything goes to the agent, except the escape prefix `Ctrl-]`: then `d` detaches, `r` releases control, and `Ctrl-]` sends a literal `Ctrl-]`. This follows `telnet`'s escape character.
- **Size mismatch.** If the local terminal is smaller than the PTY, a one-line notice says so. pacer does not reflow.
- **Remote tasks.** For a task on an SSH host, it plays the mirrored recording (read-only) until phase 5.

## 6. Many viewers, control and disconnects

- **Viewers.** Up to 16 per session. Each one gets a snapshot, then the live stream. The 17th is refused with a clear message.
- **Fan-out never blocks the agent.** Each viewer has its own output queue, capped at 1 MiB. When a queue overflows, the host drops it, sends `resync` and then a fresh `snapshot`. The PTY is always read at full speed.
  - Orca pauses its PTY for its single client. pacer cannot, because a viewer is optional and the agent must not stall behind someone's slow Wi-Fi.
- **One controller.**
  - `take` succeeds when nobody has control.
  - `take { force: true }` steals it: the previous holder gets `control { reason: "taken" }` and drops back to read-only.
  - The app asks "Someone is in control from `<label>`. Take over?" before it sends `force`.
- **Size.**
  - The controller's size is the PTY size. A `size` message from anyone else is ignored.
  - With no controller, the PTY keeps the last size, starting at 120×40. A headless agent's output does not depend on a viewer's window.
  - Read-only viewers render at the PTY size: the app scales its xterm.js view to fit, and the CLI shows the notice above.
- **Disconnects.**
  - A viewer that disconnects is removed from the fan-out, and nothing else happens.
  - A controller that disconnects releases control immediately (`control { reason: "disconnected" }`). The agent keeps running.
  - `pacer serve` restarting closes every WebSocket viewer. The app reconnects with `from` (a gap-free resume while the host still has the bytes, otherwise a snapshot).
  - The runner (`pacer _run`) dying does not touch the session host. `resumeAttempt` re-attaches by reading files, as today.
- **Session host failure.** If the session host itself dies, the PTY master closes and the agent gets SIGHUP. This is the one single point of failure, and it is no worse than today's wrapper. The host is kept small: no network, no config loading after start, and every write path wrapped so a full disk ends the recording, not the agent. `supervise` already reports a vanished wrapper as `lost`.
- **Audit.** Attach, detach and control changes are recorded as marker frames with the client label. The task's progress line shows "controlled from `<label>`" while someone has control.
- **Taking control of a headless run** is allowed, but stdin is the prompt file. A controller can send signals (Ctrl-C, Ctrl-Z) and resize; most CLIs in headless mode read nothing else. Interactive runs are where typing to the agent matters.

## 7. Testing

The plan follows the existing layout: `bun test` units in `test/`, fixtures in `test/fixtures/` using temp-dir paths, and manual release checks in `docs/testing/`.

**Unit tests (pure, every platform):**

- The `session.log` frame codec, including recovery from a torn last frame.
- The plain-text normalizer: escapes split across chunks, `\r` overwrites, wide characters.
- Secret masking across chunk boundaries.
- The control state machine: take, force, release, disconnect, input from a non-controller.
- Queue overflow leading to resync.
- `TaskData.session` and `attach` envelope parsing.
- `task.session` op output.

**Integration tests (Linux and macOS CI runners, which `ci.yml` already uses):**

- **Session host with a fixture agent.** A shell script that prints colours, reads `stty size`, sleeps, honours SIGTERM, and exits with a chosen code. Checks:
  - `readRun`, `stopRun` and `supervise` behave exactly as with the wrapper (reuse the existing supervisor tests, parameterized over both hosts);
  - stop gives 143;
  - the exit code is preserved;
  - `detectLimit` fires on a limit message printed in colour.
- **Attach correctness.** A viewer joining mid-run, and replaying `session.ckpt` plus the log offline, both produce the same serialized screen as the live headless xterm at the same output offset.
- **Several viewers and control** over the Unix socket: input from a viewer is dropped, input from the controller arrives, and a forced take notifies the old controller.
- **The WebSocket bridge in `pacer serve`.** Auth (no token gives 401; a cookie with a foreign Origin is refused), frames pass through unchanged, and resume with `from` works.
- **The compiled binary.** The release dry run (`gh workflow run release.yml -f dry_run=true`) already smoke-tests all four binaries; add `pacer _session` with the fixture agent to that smoke test.
- **Remote (phase 5).** The existing remote tests fake `runRemote`. Add a test of the `script(1)` wrapper that runs only when util-linux `script` is present.

**Manual check:** a new `docs/testing/live-sessions.md` covering:

- attaching from iTerm, Ghostty, tmux and over SSH, plus an Orca terminal and the app;
- resize while in control;
- a forced take from a second client;
- killing `pacer serve` mid-view;
- a task on an SSH host.

## Rollout

| Phase | Ships | Default |
| --- | --- | --- |
| 0. Spike | `Bun.Terminal` in compiled binaries on four targets; `@xterm/headless` bundling; what each agent's headless launch shows in a PTY; util-linux `script` with stdin from a file | Not shipped |
| 1. Recording | Session host for local direct runs, `session.log`/`.ckpt`, derived `stdout`, masking, `pacer attach` read-only, retention changes | Opt-in: `execution.session: pty` |
| 2. Live viewers | Session socket fan-out, `task.session`, WebSocket bridge, app terminal view (xterm.js), `attach` command for Orca, dashboard Attach, protocol 2.1.0 | **On** for local direct runs once phase 1 has been used for a release |
| 3. Take control | `take`/`release`, `--control`, app "Take control", idle-timer pause, marker frames | On |
| 4. Interactive mode | `session: interactive` per runner, `pacer report`, per-launch hooks, transcript reports, `needs-input` alerts | Opt-in per runner |
| 5. Remote | (a) `script -qfec` recording on hosts with read-only mirroring, then (b) uploading the pacer binary to hosts (hash-checked, like Orca's runtime upload) and running the same session host there, with the socket reached through the ControlMaster | (a) on; (b) opt-in |

The `orca` backend is unchanged throughout. Its tasks report `session.kind: "orca"`, and `attach` switches to their Orca terminal.

## Remote hosts in more detail (phase 5)

**(a) Read-only recording.**

- `SCRIPTS.START` (`src/remote/scripts.ts`) runs the agent as `script -qfec '<agent> < "$D/stdin"' "$D/session.raw" > /dev/null`. `-e` returns the child's exit code, which `run.sh` already records. `stdout` is no longer written on the host.
- `script` comes from util-linux, the same package as the `setsid` that `pacer host check` already requires. `host check` gains a `script` line.
- `RemoteRunIO.read` (`src/remote/run-io.ts`) mirrors `session.raw` with the `READ_FROM` script, as it does for `stdout` today, then derives the local `stdout`, `session.log` and checkpoints itself. The local record looks the same for local and remote runs, and every reader above keeps working.
- Live viewing of a remote run follows the mirror, which polls every 5 s (`finishRun`'s `pollMs: 5000`).
  - While a viewer is attached, the mirror switches to a streaming read: `tail -c +<offset> -f "$D/session.raw"` over the existing ControlMaster, ended when the viewer leaves. Viewing is near real time and costs nothing when nobody watches.
- `script` has no size cap. The attempt timeout bounds the file on the host, and `pacer host clean` removes it. The local mirror applies the normal cap and rotation.

**(b) Full sessions on the host.** pacer is one static binary per platform, as Orca's server plus pinned Node is.

- pacer uploads its own release binary for the host's OS and architecture into `~/.pacer-remote/bin/<sha256>/`, checks the hash on the host, and runs `pacer _session` there in place of `script`.
- The session socket is reached with `ssh -L`/`-W` streamlocal forwarding over the ControlMaster. If sshd refuses forwarding, pacer falls back to an exec channel that pipes the socket, as Orca does.
- Take-control and exact snapshots then work for remote runs too.
- Phase 0 records the glibc floor of the Bun-built Linux binaries, so `host check` can report hosts that are too old.

## Not in this design

- Parsing the terminal into a structured agent UI (messages, tool calls). Interactive mode reads hooks and transcripts for status and results only, and the terminal stays the UI.
- Windows. pacer does not ship Windows binaries, and `Bun.Terminal` is POSIX-only.
- Sharing a session with another person or machine beyond SSH to the pacer host.
- Changing the `orca` backend or replacing Orca's own terminals.

## Open questions

1. **Where Codex hooks go per launch.** Codex reads hooks from `CODEX_HOME`. If it has no per-run override, interactive mode for Codex either uses a temporary `CODEX_HOME` overlay, which may disturb account selection, or stays headless. Phase 4 decides after testing.
2. **Phase 2 default.** It is on for local direct runs. Should endpoint (OpenCode) runs wait until masking has been exercised against real endpoint keys?
3. **Recording off.** Should a setting turn recording off entirely (live view only, nothing written) for users with strict data rules? This design records by default because offline replay and late attach depend on it.
