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

For native accounts, pacer never reads or copies credentials or Keychain entries.
It only selects the agent's config folder. Default accounts have neither `home`
nor `orca_account`, and pacer does not set account environment variables for
them. There is at most one default account per native account kind.

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

## Endpoint accounts (OpenCode)

Run `pacer account add` and choose **Model endpoint (OpenCode)**. Enter a name,
an HTTP(S) base URL, where to keep the key (`keychain`, `file`, `env:VAR` or
`none`; blank picks Keychain on macOS and a file elsewhere) and, for Keychain or
file storage, a hidden API key (leave it empty for a local server with no key).
pacer discovers models through `/models`, lets you choose which to use,
and asks for context and output limits when the server does not provide them
(defaults: 128K context and 16K output). Choose quota, metered or unmetered usage,
then accept the optional test task. Metered usage asks for a weekly token budget
(for example `50M`). Quota usage reads its quota with `arkcli`, the only supported
quota source, so a blank answer selects it; pacer warns when `arkcli` is not on
`PATH`, because the account's usage stays unknown until it is installed.

Each answer is checked when you enter it. An invalid kind, name, key storage,
usage, budget or quota source is explained and asked again without losing earlier
answers. If saving still fails, the full reason is shown.

If the URL is unreachable, pacer asks you to check it and try again. A 401/403
asks for the key again; a server without `/models` allows manual model ids.
A name already in use points you to `pacer account edit <name>`.

pacer generates the provider and creates `opencode#<name>`, using
`pacer-<name>/<model-id>`, at the end of routing's default rule. The test runs
only in a temporary git repo, asks OpenCode to create `hello.txt` containing `ok`,
checks the file and removes the repo. It has a two-minute timeout and consumes
a small number of tokens. Only a passing test reports **Ready**. A failed test
keeps the account, reports **Not working** with a reason, and excludes its runner
from routing until repaired and retested.

For scripts, supply the connection explicitly:

```sh
pacer account add endpoint acme --base-url https://api.example.com/v1 \
  --key env:ACME_API_KEY --models coder --usage unmetered
pacer account add endpoint local --base-url http://localhost:1234/v1 \
  --key none --models qwen3 --usage unmetered --no-test
```

With `--key keychain` or `--key file`, pipe the key on stdin; never put its value
in command arguments. `--context` and `--output` set model limits (defaults 128K
and 16K). Metered usage also needs `--weekly-tokens`, and quota usage needs
`--quota-source arkcli`.

### Keys and generated config

| Key source | Storage |
| --- | --- |
| `keychain` | macOS login Keychain, service `pacer`, account `endpoint/<name>`; interactive default on macOS |
| `file` | `$PACER_HOME/secrets/<name>.key`, mode 0600 in a 0700 directory; interactive default on Linux |
| `env:VAR` | Reads `VAR` from pacer's environment at launch; manage it yourself |
| `none` | No key, for local servers that do not require authentication |

`PACER_HOME` defaults to `~/.pacer`. Keys never appear in the strategy, generated
config, task records, logs, events or API results. At launch pacer reads the key
from its source and supplies `PACER_KEY_<NAME>` only to the OpenCode child
(uppercase account name, with hyphens replaced by underscores).

pacer writes `$PACER_HOME/opencode/opencode.json` atomically, mode 0600 in a
0700 directory, after account changes and refreshes it at launch. It contains
`pacer-<name>` providers and environment placeholders for keys. `OPENCODE_CONFIG`
merges this file with OpenCode's config; pacer never edits the user's config.
pacer runs `opencode run --standalone` so its private server inherits the
generated config and key even when the user runs OpenCode's background service.
Managed endpoint runners always use the direct backend, including when Orca is
selected; the Orca executor backend never receives their keys.

### State, edits and removal

`pacer account list --json` includes a safe connection summary (`api`,
`base_url_host`, `key: present|missing`, and models), plus the endpoint state,
optional detail and last test time (`checked_at`).

| State | Meaning |
| --- | --- |
| Ready (`ready`) | Last test task passed |
| Not tested (`not_tested`) | No passing test yet, for example after `--no-test` or an edit |
| Not working (`not_working`) | Test failed; reason is recorded and routing excludes the runner |
| Key missing (`key_missing`) | Stored key or environment variable is absent; routing excludes the runner |
| External OpenCode provider (`external`) | Legacy endpoint without a managed connection |

State lives in `$PACER_HOME/endpoints/state.json` (0600), separate from
`strategy.yaml`. Tests update this file rather than rewriting the strategy.
`pacer route` shows the reason for excluding a Not working or Key missing runner.

```sh
pacer account models acme
pacer account models acme --refresh
pacer account edit acme
pacer account test acme
pacer runner rm opencode#acme
pacer account rm acme --delete-key
```

`models` lists configured models; `--refresh` discovers them again and prompts
for a new selection. Interactive `edit` changes the URL, key, models or usage
and offers a test. Flag-based edits leave the connection Not tested; run
`account test` to verify it.

For an external provider, interactive `edit` offers to adopt it: pacer reads only
the provider's base URL and model definitions from the user's OpenCode config
and asks for a new key. It never copies a literal key from that config.

Remove the runner before removing its account. Removal drops the generated
provider and asks whether to delete a stored Keychain or file key;
`--delete-key` deletes it without that prompt. Environment keys are never deleted.

### Legacy endpoint budgets

Accounts without `connection` remain **External OpenCode provider** accounts
and work as before with providers configured by the user:

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

## Sign in from the app

The Accounts screen can open sign-in through `account.signin { name, target? }`.
It uses the account's configured folder and tries Orca, the terminal app, then
tmux. If none is available, it returns a command to copy. Endpoint accounts have
no interactive login and refuse this operation.

An authentication failure marks `signedIn: false`; a fresh successful usage read
clears the mark. Account attention offers **Sign in** and **Disable** for enabled
executors using that account. The planner cannot be disabled or removed, and
accounts referenced by executors show why they cannot be removed. After opening
sign-in, the service checks usage every 15 seconds for up to ten minutes.
