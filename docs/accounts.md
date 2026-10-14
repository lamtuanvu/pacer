# Accounts and runners

An account owns a usage budget. A runner is an agent using that account. The
planner is a runner too; selecting its account moves the pacer integration into
that account's config folder. Runners sharing an account share its budget.

Runner ids use `<agent>[#<account>][@<host>]`: `claude-code` uses its default
account, `claude-code#work` uses `work`, and `opencode#acme` uses endpoint `acme`.
Each part uses lowercase letters, digits and hyphens. Remote `@host` ids are
reserved and refused in this release. There are no separate runner nicknames.

| Agent | Account kind |
| --- | --- |
| claude-code | claude |
| codex | codex |
| cursor | cursor (default only) |
| agy | agy (default only) |
| opencode | endpoint |

## Create and sign in

```sh
pacer account add claude work
pacer runner add claude-code#work
pacer config set planner claude-code#work
```

A pacer-managed account uses a new folder under `~/.pacer/accounts/<name>`,
created with permissions 0700. Choose another new folder with `--home <dir>`.
Claude starts with `CLAUDE_CONFIG_DIR` pointing at that folder; run `/login`,
then exit to return to pacer. Codex runs `codex login` with `CODEX_HOME` set.
The login process inherits your terminal. `--no-login` configures the account
without starting a login. A failed login leaves the account configured.

pacer never reads or copies credentials or Keychain entries. It only selects the
agent's config folder. Default accounts have neither `home` nor `orca_account`,
and pacer does not set account environment variables for them. There is at most
one default account per native account kind.

## Link an Orca account

```sh
pacer account add codex team --orca team-id
pacer runner add codex#team
```

Use an id from `orca account list --json`. pacer verifies that it belongs to the
requested kind, and displays sanitized labels and ids rather than account
emails. It derives Claude homes from Orca's `claude-profiles/<id>/home` and
Codex homes from `codex-accounts/<id>/home`, beneath Orca's data folder.
This is a workaround tracked in [#19](https://github.com/lamtuanvu/pacer/issues/19).
If the derived folder is missing, the account remains available for usage
reporting but cannot execute tasks or become an installed planner.

## Endpoint budgets

```sh
pacer account add endpoint acme --usage metered --weekly-tokens 50M
pacer runner add opencode#acme --model acme/gpt-x
pacer account add endpoint byteplus --usage quota --quota-source arkcli
pacer runner add opencode#byteplus --model coding-plan/dola-seed-2.0-code
pacer account add endpoint local --usage unmetered
pacer runner add opencode#local --model ollama/qwen3
```

Metered accounts require a positive weekly token budget; `K`, `M` and `G`
suffixes are accepted. Quota endpoints require `--quota-source arkcli`.
OpenCode runners require a `<provider>/<model>` model, either inherited from
an account's YAML `model` setting or supplied with `runner add --model`.
New runners are added to routing's default rule.

## Inspect and remove

```sh
pacer account list --json
pacer runner list --json
pacer runner rm opencode#acme
pacer account rm acme
```

Account JSON includes kind, source, folder or Orca id, usage settings and
`usageReading`, runner ids, `runnable`, and `signedIn`. Native sign-in state is
`null` because pacer does not inspect credentials; a linked Orca identity is
reported as signed in. Runner JSON includes id, agent, account, host and model.

Account removal is refused while the planner or any runner uses the account.
Runner removal is refused for the planner and the last runner; successful
removal deletes its references from routing, pacing order and runner declarations.
Empty routing rules are removed. Account homes are retained by default.
`account rm <name> --delete-home` requires a y/N confirmation, works only for
pacer-managed accounts, and refuses protected, shared or symlinked homes.

## Strategy edits and migration

Commands edit the active strategy, preserving comments and untouched layout,
and validate the whole result before writing. A refused edit leaves the file
unchanged. Existing `providers:` strategies continue to load; run
`pacer config migrate` before adding or removing accounts or runners.
Migration also runs during init and update. It writes a `.pre-accounts.bak`
backup, describes the change, and prints the restore command.

`pacer config set planner <runner id>` installs the new account's integration,
removes the recorded old integration, and prints an undo command. If installation
fails, pacer restores the strategy. Existing running sessions keep their account;
start a new session from the selected folder to use the new planner account.

`pacing.accounts` defaults to `spread`. `fill` prefers accounts in pacing order
until an account is behind pace or reaches `pacing.fill_threshold` (default 90%,
range 50–100). These choices apply within matching native agent/account-kind
groups; endpoint routing retains its existing ordering.

## Limits

In 0.1.23, runners on a non-default account folder (pacer-managed `home` or
Orca-managed) always use the direct backend, including when `execution.backend`
is `orca` or `auto`. An interactive Orca launch cannot pre-approve workspace
trust for that account and can stop at the folder-trust dialog. The attempt log
records this reason; default accounts keep their existing backend behavior.
