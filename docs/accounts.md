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

A pacer-managed account uses a new folder, `~/.<kind>-<name>` (for example
`~/.claude-work` or `~/.codex-work`), created with permissions 0700. Choose another new folder with `--home <dir>`.
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

Run `pacer account add` and choose **Model endpoint (OpenCode)**. pacer first
looks for models you can already use and lists them:

- **Already signed in to OpenCode**: providers from `opencode auth list` and
  your `opencode.json`. pacer refers to the provider and never reads or copies
  its key, so rotating the key in OpenCode just works.
- **Running on this machine**: Ollama (`localhost:11434`) and LM Studio
  (`localhost:1234`), when they answer within a second.
- **Connect a provider**: search the models.dev catalog (the data OpenCode
  uses, cached for 24 hours in `~/.pacer/cache/models.json`). pacer runs
  `opencode auth login <provider>` in the same terminal; OpenCode asks for the
  key and stores it. pacer never sees it.
- **Enter a URL yourself**: the pacer-managed connection described below.

For a detected provider, pacer recommends one model that can call tools and
produce text (`/` searches the others), sets the usage type from the catalog and
asks only when the catalog cannot tell, offers an optional **weekly spend cap in
dollars** for metered usage, suggests a name and offers the test task. Every
prompt accepts its default on Enter. Providers that already have an account show
`added as <name>`.

```sh
pacer account add opencode openrouter --cap-usd 10
pacer account add opencode openrouter --model z-ai/glm-5.3 --name or-glm --no-test
```

Without `--model`, the recommended model is used. `--usage` sets the usage type
when the catalog cannot tell; a weekly dollar cap applies only to metered usage
and is refused otherwise. A provider account is stored
with `source: opencode` and no connection or key:

```yaml
accounts:
  openrouter:
    kind: endpoint
    source: opencode
    provider: openrouter
    usage: metered
    budget: {weekly_usd: 10}   # optional; omitted means no cap
```

Its runner model is `<provider>/<model>`. OpenCode merges pacer's generated
config with yours and resolves the key itself. If the provider is later signed
out of OpenCode, the next check reports **Key missing — run `opencode auth login
<provider>`**. Spend is read in dollars from `opencode stats --cost` and is always
shown in `pacer account list` and Settings › Accounts ("$3.20 this week", or
"$3.20 of $5 this week" with a cap, plus "cap reached" once it is reached). With a cap, the reading has a `7d $` window whose used
percent is spend divided by the cap, and pacing treats a reached cap like any full
window. Accounts without `connection` or `source` stay **External OpenCode
provider** accounts (see [Legacy endpoint budgets](#legacy-endpoint-budgets));
to get the provider checks and dollar spend, add the provider again with
`pacer account add opencode <provider>`.

OpenCode quota accounts for `coding-plan`, `byteplus-coding-plan` and
`volcengine-coding-plan` use ArkCLI automatically. Existing quota accounts with
no explicit usage source also select that reader when loaded; no re-add is needed.
ArkCLI must be installed and signed in to the matching plan account.
If Settings › Accounts reports an Ark CLI sign-in error, run `arkcli auth login`
in a terminal and complete BytePlus sign-in in the browser. Then choose **Refresh
usage** for that account. An expired Ark CLI login does not mean the plan
subscription is missing, and OpenCode's provider sign-in is separate.

### Endpoints at your own URL

Choose **Enter a URL yourself**, then enter a name, an HTTP(S) base URL, where to keep the key (`keychain`, `file`, `env:VAR` or
`none`; blank picks Keychain on macOS and a file elsewhere) and, for Keychain or
file storage, a hidden API key (leave it empty for a local server with no key).
pacer discovers models through `/models`, lets you choose which to use,
and asks for context and output limits when the server does not provide them
(defaults: 128K context and 16K output). Choose the usage type, each with a
one-line explanation: quota (a plan with limits), metered (pay per token) or
unmetered (free or local). Then accept the optional test task. Metered usage may
set a weekly token budget (for example `50M`); leave it blank for none. Quota usage reads its quota with `arkcli`, the only supported
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
and 16K). Metered usage may add `--weekly-tokens`; quota usage needs
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
| Not tested (`not_tested`) | No passing test yet, for example after `--no-test` or an edit. Routing still uses the runner; the Executors screen, Overview and tray show it as Not tested, not Ready |
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

A metered account's weekly token budget is optional and, when set, must be
positive; `K`, `M` and `G` suffixes are accepted. A dollar cap is set with
`budget.weekly_usd` on the account in `strategy.yaml`; nothing migrates
automatically. Quota endpoints require `--quota-source arkcli`.
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
`usageReading`, runner ids, `runnable`, and `signedIn`. Runner JSON includes id,
agent, account, host and model.

Claude executor checks collect quota windows from Claude Code's own structured
test-task output into that account's usage cache. This works for default,
pacer-managed and linked Orca accounts without installing a planner status line
or reading credentials. If usage was missing or stale, the check verifies it
again after the test task; missing quota telemetry fails **Usage readable** with
guidance to update Claude Code and check the subscription. Interactive sessions
can also update usage through the installed status line.

Normal headless Claude tasks also capture the structured quota event when the
task finishes. Pacer installs an account-scoped status line when it creates a managed
Claude account, and fills in a missing status line for an existing managed
account the next time it launches that account. An existing custom status line
is preserved; to capture its quota data, have it pass Claude's status-line JSON
to `pacer statusline` with that account's `CLAUDE_CONFIG_DIR` set. Pacer does not
run idle background prompts to refresh usage. A reading ages when there are no
new Claude turns, and an expired window stays unknown until new telemetry arrives.

After a task finishes, pacer refreshes the executed account's available usage
source before recording `usageAtEnd`. Codex uses its session logs. Metered
OpenCode accounts query `opencode stats`, and supported quota endpoints query
their provider CLI. Those commands may still report delayed provider data.
Cursor and Antigravity only report observed limit hits; pacer does not invent a
numeric quota percentage for them. Unmetered accounts have no quota to refresh.

### Usage reader plugin (unreleased)

The bundled `pacer-usage` plugin reads Claude Code quota telemetry, Codex session
logs, Ark Coding Plan quotas and metered OpenCode statistics. Account budgets,
reading timestamps, freshness, spending and conflicting observations keep their
existing meaning. Pacer still owns aggregation, authentication state, exhausted
marks and remote observation merging. Reactive and unmetered accounts do not
start a usage plugin.

Claude and Codex reads are passive: they use captured telemetry or the selected
account's logs without launching a prompt or reading native credentials. The
other readers run only these read-only provider commands:

```sh
arkcli usage plan --product coding-plan
opencode stats --models --cost --json --days 7
```

If no enabled reader is available, or the selected reader fails, fetching new
usage reports a readable error and unknown usage; there is no built-in fallback. Existing cached
observations retain their original capture time. Use the [plugin commands](cli.md#plugins-unreleased)
to inspect or enable `pacer-usage`.

The bundle is enabled by default. `plugins.disabled` in the strategy file can
include `pacer-usage`, or use `pacer plugin disable pacer-usage`. Its declared
capabilities are scoped `fs.read`, `process.spawn` and `usage.state`. The last
provides access only to host-selected usage cache and cursor stores, without
arbitrary file writes. Installed plugins require an explicit grant for their
requested capabilities. Usage requests contain selected account identity and
budget settings, not endpoint keys or credential contents.

### Sign-in state

`signedIn` is the account's local sign-in on this machine. One check supplies it
to `account list`, routing (`pacer route`), the Executors and Accounts screens,
account attention and `runner.check`:

| Account | `signedIn` |
| --- | --- |
| Claude, Codex or Cursor with a local runner or no runners | `true` when the agent's own config shows a login, otherwise `false`; also `false` after an authentication failure recorded since that login |
| Used only by remote runners | `false` after a recorded authentication failure, otherwise `null` (the login lives on the host) |
| Orca account whose folder is missing | `true` for a linked Orca identity, otherwise `null` |
| Endpoint | `null`: endpoints use keys, so their endpoint state (Ready, Not tested, Not working, Key missing) is shown instead |

The login check never reads credentials. It looks for an `oauthAccount` entry in
Claude's `.claude.json`, the presence of Codex's `auth.json`, or Cursor's
`authInfo`, in the account's folder, or for the agent's API key variable in
pacer's environment. A recorded authentication failure stops counting once the
agent rewrites that file, for example after you log in again.

A signed-out executor is excluded from routing with the reason
`signed out — <fix>`, shown as Unavailable with that reason in the Executors
table, and raises one **Sign in** attention item for its account. `signin_command`
and the app's **Fix sign-in** appear only for a native account that is signed out.
The planner's own runner is not excluded this way; setup reports a signed-out
planner instead.

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
records this reason. Default accounts also use direct execution when Orca is
selected: Orca worker-start cannot enforce pacer's permission bypass policy.

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

## Eligibility evidence

Account evidence is stored by account source identity. Replacing an account home or source does not reuse its previous evidence. Availability, quota and spending signals have separate timestamps. See [execution eligibility](executors.md#execution-eligibility-and-evidence) for freshness and recovery rules.

Changing an OpenCode provider also changes that identity. Changing a weekly cap keeps authentication and execution restrictions, but percentages calculated under the previous cap no longer constrain routing. An uncapped metered account needs no budget evidence; a successful usage reading can confirm availability. Missing or malformed costs stay unknown, and retained spending after a failed refresh is labelled historical even when the account has no cap.
