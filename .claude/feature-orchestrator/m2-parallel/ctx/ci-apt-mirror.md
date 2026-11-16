# Task: make CI apt installs survive an unresolvable Azure Ubuntu mirror

Executor: OpenCode Go GLM 5.3 Flash (small task). Workflow YAML only; no builds.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/ci-pin-ubuntu, branch `ci/pin-ubuntu-24-04`, head `5c5822e71` (already pushed as PR #896; add one new commit on top, do not amend or force-push, do not push).

## Why

On PR #896 the Ubuntu 24.04 runners can't resolve `azure.archive.ubuntu.com`. The image's apt uses `mirror+file:/etc/apt/apt-mirrors.txt` with that host first, so `playwright-core/cli.js install --with-deps chromium` spends about 10 minutes on apt and then fails ("Temporary failure resolving 'azure.archive.ubuntu.com'", "Unable to fetch some archives"). It failed identically on two runs 15 minutes apart, and the name resolves fine outside GitHub.

## Change

Before every apt use in the workflows, add a step (or a line at the top of the existing `run:` block) that drops the Azure mirror only when it does not resolve, so healthy runners are unaffected:

```sh
if [ -f /etc/apt/apt-mirrors.txt ] && ! getent hosts azure.archive.ubuntu.com >/dev/null; then
  sudo sed -i '/azure\.archive\.ubuntu\.com/d' /etc/apt/apt-mirrors.txt
fi
```

Places (verify with `rg -n "apt-get|--with-deps" .github/workflows`):
- `.github/workflows/ci.yml` "Install locked Chromium test browser" (Linux only; the step also runs on macOS on main pushes, so guard by OS: the file test already makes it a no-op on macOS, keep it that way and don't call `sudo` on macOS).
- `.github/workflows/release.yml` the Playwright install (~line 123) and the `apt-get update` block (~line 190).
- `.github/workflows/desktop.yml` the `apt-get update` block (~line 87).

Keep the step names and `if:` conditions unchanged. If you add a separate step, name it "Skip an unreachable Azure apt mirror" and give it the same `if:` as the step it precedes plus `runner.os == 'Linux'`. Add one short comment at the first occurrence explaining that it is a no-op when the mirror resolves.

## Checks

- `actionlint .github/workflows/*.yml`: no new findings compared with `HEAD~0` before your change (run it before and after and diff; ignore the known "unknown runner label ubuntu-24.04" notices from the outdated local runner list).
- `git diff --check`.

Commit: `ci: skip the Azure Ubuntu mirror when runners cannot resolve it`, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

Append a section to `.work/reviews/ci-pin-ubuntu-handoff.md`: the commit, each place changed, the actionlint comparison. Report with `orca orchestration worker_done`. Always end with worker_done.
