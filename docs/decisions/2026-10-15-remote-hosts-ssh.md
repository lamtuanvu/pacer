# Remote hosts over SSH decision — 2026-10-15

Status: owner decisions recorded 2026-10-15; remote agent live verification
requires separate owner approval.
Source: section 4 of the core-contract design on `docs/remote-runners-design`
and the phase 5 implementation plan. The 2026-10-14 SSH spike verified shell
detach, disconnect survival, log mirroring, stop, identity and bundle transfer;
it did not verify a headless remote agent run.

## Context

pacer owns executor control, progress, limits and remote host control across
all clients. Remote execution must work without Orca and without installing
pacer or Bun on the host. The core contract supersedes the earlier Orca-based
remote dispatch design. The owner selected the transfer, identity, account and
acceptance policies on 2026-10-15.

## Decisions

- **D1. SSH is owned by pacer:** use the direct backend and file-backed
  supervisor over a BatchMode SSH alias, rather than Orca dispatch. Remote
  scripts run under `bash -lc` so login-shell PATH setup applies. Hosts need
  git ≥ 2.30, a logged-in headless agent CLI and `setsid` (`util-linux` on
  Linux). Fixed scripts receive quoted arguments; briefs and prompts use stdin.
- **D2. Bundle over SSH stdout:** return results as a git bundle on
  `pacer/<task-id>`. This release has no push mode. Verify ancestry, a clean
  worktree, 1–500 commits and identity before transfer; cap bundles at 50 MB,
  verify locally and refuse an existing local task branch.
- **D3. Explicit repo-local identity:** `pacer host setup` sets the host
  checkout's `user.name` and `user.email` to the local repository's values only
  after confirmation. Host checks compare both values. Transfer pre-flight
  rejects author, committer or `Signed-off-by` emails that differ from the
  local repository's email.
- **D4. Per-account folders on hosts:** allow
  `hosts.<alias>.accounts.<account>.home`, passed as `CODEX_HOME` or
  `CLAUDE_CONFIG_DIR`. A non-default remote account needs this declaration.
  Credentials are never copied. Codex usage is probed from host session logs;
  the newest reading wins for the account. Remote-only Claude accounts remain
  reactive until usage rung 2 is verified.
- **D5. Local acceptance:** fetch the result into a local review worktree and
  run acceptance locally before recording review. Remote agent live tests
  require separate owner approval under core-contract decision 5; shell-spike
  evidence does not supply that approval.

## Consequences

The host needs no pacer, Bun or Orca. Users prepare their own SSH alias, host
keys and agent login. No credentials are forwarded and no pushes occur. Only
git content returns; uncommitted or untracked work cannot be transferred.

Detached runs survive connection drops and can resume after a pacer restart.
Continuous unreachability ends the attempt as `lost` after ten minutes, so the
host may need inspection before retrying. Transfer refusals leave a `partial`
task and preserve its host branch and worktree. Cleanup removes eligible
settled worktrees and run files; it deletes a remote branch only when a local
task branch exists.

Briefs are stored as agent input on the host and must not contain secrets.
Acceptance depends on the local environment even though implementation ran
remotely. Passive Codex readings can inform routing across hosts; Claude usage
on a remote-only account is reactive for now.

## Revisit when

- **Push mode:** users need an alternative to bundle transfer and its identity,
  ancestry and ref-write safeguards have been specified.
- **Paired servers:** a persistent authenticated host service offers enough
  benefit over SSH to justify installation, pairing and lifecycle management.
- **Claude usage rung 2:** rate limits from headless Claude output are verified,
  allowing passive remote usage readings in place of reactive-only tracking.
