# Remote runners over SSH

pacer can run Codex and Claude Code on another machine using a runner ID such
as `codex@box` or `codex#team@box`. pacer owns the SSH connection, isolated
worktree, supervision and result transfer. Review and acceptance happen locally.

## Prepare the host

The host needs:

- git ≥ 2.30 and a checkout of the repository with the expected `origin`.
- A logged-in `codex` or `claude` CLI on the login-shell PATH, able to run
  headless without trust, login or other startup prompts.
- `bash` and `setsid` (`util-linux` on Linux hosts), used to detach the agent
  from the SSH connection.
- An SSH alias configured on your local machine that works with
  `BatchMode=yes`, including any required host-key verification completed by you.

Remote scripts run under `bash -lc`, so put the agent CLI on that shell's PATH.
The host needs no pacer, Bun or Orca installation. Authenticate the agent on the
host yourself; pacer does not transfer logins or configure SSH.

## Configure a host and its runners

Add `hosts:` to your active strategy (`~/.pacer/strategy.yaml` by default).
The host alias in runner IDs selects a configured SSH alias and repository map:

```yaml
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  team: {kind: codex, home: ~/.codex-team}
planner: claude-code
hosts:
  box:
    ssh: box-ssh
    repos:
      github.com/example/project: ~/src/project
    max_tasks: 2
    accounts:
      team: {home: ~/.codex-team}
routing:
  - default: [codex@box, codex#team@box, codex]
```

Repository keys use lower-case `host/owner/repo` without `.git`, matching the
local repository's `origin`. Each repository used remotely needs a mapping to
its host checkout. `max_tasks` defaults to 2 and accepts 1–16. Host aliases use
lower-case letters, digits and hyphens, starting with a letter or digit; `local`
is reserved. `@local` normalizes to a local runner. The planner must run locally;
only `codex` and `claude-code` support remote execution.

### Account folders

The top-level account identifies the shared budget. Its local `home` and the
host's `accounts.<name>.home` are separate paths on their respective machines.
A non-default account requires a home declared under that host. Log in to the
agent with that folder on the host before using it.

pacer passes the declared remote folder as `CODEX_HOME` or `CLAUDE_CONFIG_DIR`,
expanding a leading `~/` on the host. Without an override the agent uses its
default host folder. The planner's local account environment is not forwarded.

## Set up and check

Run from your local repository, or pass its path with `--repo`:

```sh
pacer host list
pacer host setup box --repo ~/src/project
pacer host check box --repo ~/src/project
```

`setup` offers the exact clone command when the mapped checkout is missing.
Its checkout preview uses the bundled SSH host runner; if that plugin is
unavailable, setup stops before offering a clone and does not retry direct SSH.
An approved clone also uses the bundled runner's fixed command. If the
connection ends without a completion receipt, setup stops without retrying;
check the host before requesting setup again. Cloning requires confirmation.
It separately asks before setting the checkout's
repo-local `user.name` and `user.email` to your local repository's effective
identity, then runs the checks. Configure that local identity first. Setup is
interactive with y/N prompts; non-TTY runs decline changes.

`check` tests SSH, git, `setsid`, the agent CLIs used on the host, declared account
folders, checkout origins and repo-local identity. Without `--repo`, it checks
all mapped checkouts against the identity of your current local repository.
Its read-only SSH, tool, account-folder and checkout/identity checks run through
the bundled SSH host runner plugin. If that plugin is disabled or unavailable,
the check reports the affected checks as failed without a direct SSH retry.
A paused host can still be checked without making it eligible for work.
It prints one line per check, such as `ok  ssh` or `FAIL git: git 2.25 < 2.30`,
and exits 1 when checks fail. When SSH fails, remaining checks say `skipped`.
`list` and `check` support `--json`.

## Run, transfer and review

Preview choices with `pacer route docs --json`. To request a host explicitly:

```sh
pacer delegate --goal 'Update the project guide' --kind docs --executor codex@box --worktree new --json
```

Remote runners need new placement; they cannot use `worktree: current`. The
local base commit is fetched on the host, or sent as a git bundle if it is
unpublished. pacer creates `pacer/<task-id>` in an isolated host worktree under
`~/.pacer-remote/worktrees/`. Attempt files and agent input live under
`~/.pacer-remote/runs/<task-id>/<attempt>/`.

The detached wrapper records the process, exit code and live output in files.
Completion waits until the recording mode is known, so a fast exit during native
session startup does not skip copying the recording back to the local task.
pacer polls every five seconds and mirrors output locally, so the normal task
logs and progress views work. Restarting pacer resumes the recorded remote run.
For hosts using full sessions, pacer reads recording metadata and file ranges
through the bundled SSH plugin in bounded pages. If files rotate during a read
or the provider becomes unavailable, that poll waits for a consistent snapshot;
it does not retry over direct SSH. A partially published local recording is
restored on the next observation after an interruption.
An attached read-only PTY viewer reads at most 256 KiB at a time through the
same bundled SSH provider. After an empty read it waits about 200 ms before
checking again, in addition to SSH round-trip time. Detaching cancels the
pending read; reconnecting resumes from the committed recording cursor. A
disabled or failing provider does not trigger a direct SSH tail.
For an interactive full-session viewer, pacer connects the local viewer socket
through the bundled SSH plugin's host-issued stream. Each viewer has its own
grant for the persisted run; output and input move in bounded acknowledged
chunks. Detaching or losing the provider closes that viewer connection, and
reconnecting opens a fresh stream. An idle viewer stays connected through
short empty polls. No direct SSH forwarding or exec fallback follows a plugin
refusal. A run accepts at most two attached viewers, and at most four viewers
stream at once across all runs; pacer closes an extra viewer's connection
immediately. Viewer streams never use the plugin call slots that reachability,
usage and run polling need.
The agent is instructed to commit on its task branch and leave a clean worktree.
After a nonzero agent exit, pacer checks for committed work through the bundled
SSH host runner before attempting a result transfer. A refused or timed-out
check does not trigger a direct SSH retry or a transfer decision based on
unverified output.

If the selected agent needs a local runtime binary, pacer uploads it through the
bundled SSH host runner's fixed command. The upload is limited to 128 MiB and
verified against its SHA-256 hash on the host. A disabled provider, changed task
or missing completion receipt stops the attempt without retrying direct SSH;
inspect the host before retrying an uncertain upload.
The preceding platform probe also uses that bundled runner for the exact
persisted task run. If the provider cannot report the host platform, binary
setup stops without retrying the probe through direct SSH.

Remote launch uses the bundled SSH runner's fixed START command and a one-use
grant for the persisted task run. The wrapper and prompt travel over a private
stdin channel, capped at 50 MiB, and are absent from plugin JSON. If a start
times out or its completion receipt is missing, pacer leaves that launch
uncertain and does not try direct SSH or start it again automatically.

Before returning results, pacer requires:

- The task branch descends from the recorded base.
- The host worktree is clean and the result has 1–500 commits.
- Every author, committer and `Signed-off-by` email in those commits matches
  the local repository's `user.email`.
- The local `pacer/<task-id>` branch does not already exist.

Results stream over SSH stdout as a git bundle capped at 50 MB. pacer verifies
the bundle, fetches only `refs/heads/pacer/<task-id>` and opens a local review
worktree. A successful transfer report starts
`ran on box; fetched pacer/<task-id> (<n> commits)`. Review the diff and run the
brief's acceptance command locally before recording your verdict:

```sh
pacer review <task-id> --accept --json
```

## Usage and failures

After a remote Codex task and during `host check`, pacer probes rate-limit
readings in the account's host session logs. The newest captured reading wins
against local readings for that account. `pacer limits check` identifies a
winning remote source as `session-log (via box)`. Failed probes do not block
tasks or checks. Claude accounts used only remotely have reactive limit tracking;
remote Claude usage measurement is not available yet.

An unreachable host is excluded from routing with `host box unreachable`, and
routing can fall through to the next runner. Reachability is cached for 60
seconds. The bundled remote caller probes the configured alias through the
fixed SSH provider; if either plugin is disabled or unavailable, the host is
reported unreachable until the plugin is restored or the cache expires. There
is no direct SSH retry for routing reachability. Missing repository mappings,
current placement and `max_tasks` also
exclude remote runners with a reason.

A dropped connection during a run leaves the agent running while pacer keeps
polling. After ten minutes of continuous unreachability the attempt ends `lost`
with a reason. Reconnect and inspect the host run before retrying work that may
still be running there. `pacer stop <task-id>` stops a reachable remote process
group through the normal task interface and the bundled SSH host runner. A
missing completion receipt leaves that stop operation unsettled. A later stop
may confirm its own result but cannot confirm the earlier attempt; inspect the
remote run before retrying work.

Transfer refusals produce `partial` with the reason, keeping the remote branch
and worktree for recovery. Fix identity with `pacer host setup` when appropriate;
an existing local task branch is never overwritten. A bundle already written
locally is retained on transfer failure and deleted on success.

After review, dismissal or resolution, remove settled tasks' host worktrees
and run directories with:

```sh
pacer host clean box --json
```

Cleanup reports removed and kept task IDs. It deletes a remote task branch only
when the corresponding local branch exists, preserving branches whose results
have not returned. Cleanup removes the host worktree and run files, so recover
uncommitted files or needed logs before cleaning. `pacer clean` also handles
remote resources for eligible tasks. Cleanup uses the bundled SSH host runner's
fixed command for each task. A disabled provider or missing completion receipt
keeps the task in the report without retrying direct SSH; check the host before
requesting cleanup again.

## Security

SSH calls use fixed scripts and quoted configuration arguments. Briefs and
prompts travel over stdin, never as shell commands. They are stored on the host
as the agent's input, so do not put secrets in briefs. pacer never reads, copies
or forwards credentials or keys, and adds no SSH configuration or host keys.
Only git content is transferred; files outside git are not copied. pacer never
pushes from either machine, and writes returned results only to the new local
task branch.

## Host controls in the app (protocol 2.5.0)

`host.suggest` offers concrete SSH aliases, including aliases from SSH config
Includes. `host.get { alias }` returns facts, check results, executor capacity
rows, mapped repositories, account folders and recent completed/accepted totals.
`host.check` shares a progress job between clients. `host.set` edits `max_tasks`
(1–16) and `paused`; pausing routes new work elsewhere and leaves running tasks
alone. Disabled executors still count as references when removing a host.

Host state uses this precedence: `paused`, `down` after two consecutive probe
failures, `checking` during a check job, `needs_setup` for failed checks or unmapped
known repositories, then `ready`. Every 300 seconds the service probes unpaused
hosts that have enabled executors through the SSH ControlMaster connection.
Two failures raise host attention with **Run checks** and **Pause host**; the
first success clears it. Probing never changes running task state.

`host.repo.map` accepts a canonical host/owner/repo key and a remote path.
`host.repo.setup` requires `consent: true` and can clone and set identity through
a job. `host.account.add` records an account folder and returns a login command
for the user to run. `host.clean { alias, dry_run: true }` previews worktrees as
`will remove`, `in use` or `kept`; cleanup keeps running and untransferred work.
`host.terminal` opens SSH using the same terminal selection as account sign-in.
