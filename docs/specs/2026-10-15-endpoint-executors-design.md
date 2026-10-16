# Endpoint executors: pacer owns the account, its models and the OpenCode setup

Status: decisions recorded 2026-10-15 (see Decisions). Pairs with [the pacer app](2026-10-15-pacer-app-design.md), which provides the Add executor screen.

## Problem

Today an endpoint account is only a budget entry. `pacer account add` asks for a kind, a name and a usage type, says "Added account terastorai.", and leaves something that cannot run:

- There's no connection: no base URL, no key, no models.
- There's no runner, so routing never picks it.
- OpenCode doesn't know the provider, so even a hand-made runner fails at launch.
- Nothing checks that it works. The success message is false.

To get one working executor, the user has to edit OpenCode's config by hand, pick a `<provider>/<model>` string, add a runner and hope. That's pacer's data model leaking into the user's task.

## Goal

**One flow turns "I have an endpoint" into a working executor.** The user gives a name, a base URL and a key. pacer then:

1. finds the models;
2. lets the user choose one or more;
3. writes the OpenCode provider;
4. creates the runner and adds it to routing;
5. runs a test task.

pacer reports **Ready** only after that test task succeeds.

**Success, measured on a clean account:**

- `pacer account add` (or the app's Add executor) followed by `pacer delegate --executor opencode#terastorai` completes a real task.
- The user never opens an OpenCode config file and never types a `<provider>/<model>` string by hand.
- The user's own `~/.config/opencode/opencode.json` is byte-for-byte unchanged.
- No API key appears in `strategy.yaml`, in pacer logs, in task records or on screen.

## What exists today

**pacer.**
- Endpoint accounts: `{ kind: endpoint, usage, quota_source?, budget? }`.
- OpenCode runners carry `model: <provider>/<model>`. Launch runs `opencode run --agent build -m <model> --auto …` with the default OpenCode config.
- The user's existing endpoints (`byteplus` → `coding-plan/…`, `local` → `lmstudio/…`) point at providers the user defined in their own OpenCode config.

**OpenCode 2.0.22, verified 2026-10-14:**
- **Custom providers.** A custom provider is defined as `provider.<id>` with:
  - `npm: "@ai-sdk/openai-compatible"`;
  - `options.baseURL` and `options.apiKey`;
  - `models.<id>` with `name`, `limit.context`, `limit.output` and `tool_call`.
- **Placeholders.** Config values accept `{env:VAR}` and `{file:path}`.
- **Config merge.** `OPENCODE_CONFIG=<file>` loads an extra config that is **merged with** the global config. A run with a pacer-generated file listed `pacer-spike/m1` alongside the user's `coding-plan/*` and `lmstudio/*` models. So pacer can add providers without editing the user's config.
- **Built-in auth.** `opencode auth login` stores keys in `~/.local/share/opencode/auth.json` for providers OpenCode knows.

## Design

### 1. The account owns the connection

An endpoint account gains a `connection`:

```yaml
accounts:
  terastorai:
    kind: endpoint
    usage: unmetered
    connection:
      api: openai-compatible          # the only value in this version
      base_url: https://api.terastor.ai/v1
      key: keychain                   # keychain | env:TERASTOR_KEY | none
      models:
        - id: qwen3-coder-480b
          name: Qwen3 Coder 480B
          context: 262144
          output: 65536
          tools: true
      checked_at: 2026-10-14T13:05:00Z   # last successful test task
```

- **`api`.** Only `openai-compatible` is supported in this version. Anthropic-compatible endpoints come later.
- **`key`** says where the key lives, never what it is:
  - **`keychain`** (default on macOS): the macOS login Keychain. Service `pacer`, account `endpoint/<name>`, written with `security add-generic-password`.
  - **`file`** (default on Linux): `~/.pacer/secrets/<name>.key`, mode 0600, in a 0700 folder.
  - **`env:VAR`**: pacer reads `VAR` from the environment at launch. This is for users who already manage keys that way.
  - **`none`**: for local servers such as Ollama or LM Studio.
- **`models`** is the list the user chose, with the limits pacer found. The runner's model must be one of them.
- **Existing accounts.** Accounts without `connection` keep working as today. They are labelled **External OpenCode provider** and use the user's own OpenCode config. Nothing migrates them automatically; `pacer account edit` offers to adopt them (section 6).

### 2. pacer writes its own OpenCode config

- **The file.** pacer generates `~/.pacer/opencode/opencode.json` from every account that has a `connection`. Each account becomes one provider, with the id `pacer-<account>`. The prefix means it can never collide with or override a provider the user defined.

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "pacer-terastorai": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "terastorai (pacer)",
        "options": { "baseURL": "https://api.terastor.ai/v1", "apiKey": "{env:PACER_KEY_TERASTORAI}" },
        "models": { "qwen3-coder-480b": { "name": "Qwen3 Coder 480B", "limit": { "context": 262144, "output": 65536 }, "tool_call": true } }
      }
    }
  }
  ```
- **The key never goes in that file.** At launch, pacer:
  1. reads the key from its source;
  2. puts it in `PACER_KEY_<ACCOUNT>`, in the OpenCode child's environment only;
  3. sets `OPENCODE_CONFIG` to the generated file.
- **When it's written.** pacer rewrites the file atomically after every account change, and at launch if it's missing or stale.
- **The runner's model** is `pacer-terastorai/qwen3-coder-480b`. pacer builds it; the user picks from a list.
- **The user's OpenCode config is never edited.** A later, opt-in `pacer account export-opencode <name>` could copy a provider into the user's config, with consent and a backup. It is out of scope here.

### 3. Model discovery

1. **Automatic.** pacer calls `GET <base_url>/models` with the key and timeout 10 s, and parses the OpenAI-style `{ data: [{ id, … }] }`.
   - It reads context and output limits when the response includes them (`context_length`, `max_model_len`, `max_output_tokens`, …).
   - Otherwise it asks once for the context size, defaulting to 128K, and the output size, defaulting to 16K. These are needed: OpenCode cuts off at the configured limit.
2. **Manual.** If the endpoint has no `/models` or it fails, pacer says why and asks for model ids by hand.
3. **Refresh.** `pacer account models <name> [--refresh]` lists the models, or refetches them and lets the user change the selection.

### 4. The flow

The flow is the same in the terminal and in the app. Each step validates before moving on, so the user never ends up with half an account.

```
$ pacer account add
What do you want to add?
  1. Claude Code account
  2. Codex account
  3. Model endpoint (OpenCode)      ← BytePlus, a company endpoint, Ollama, LM Studio…
> 3
Name (lowercase, e.g. terastorai)> terastorai
Base URL> https://api.terastor.ai/v1
API key (hidden, empty for none)> ••••••••
  Saved to macOS Keychain (pacer / endpoint/terastorai).
Checking https://api.terastor.ai/v1/models … 6 models.
  1. qwen3-coder-480b     262K context
  2. qwen3-coder-30b      131K context
  3. glm-5.2              200K context
  …
Models to use (e.g. 1,3)> 1
Usage (quota, metered, unmetered)> unmetered
Test with a short task now? Uses a few hundred tokens. [Y/n]> y
  Running opencode#terastorai … done in 9 s.
Ready: opencode#terastorai (qwen3-coder-480b)
  Routing: added to the end of the default rule, after local.
  Move it in the app's Executors screen.
```

**Failure paths.** Each one says what happened and what to do next:

| Failure | Message ends with |
| --- | --- |
| Base URL unreachable or not HTTP(S) | "Check the URL and try again." Asks again; nothing saved yet. |
| 401/403 from `/models` | "The key was refused." Asks for the key again. |
| `/models` missing | "This endpoint doesn't list models. Enter model ids." |
| Test task fails | Saves the account, marks the runner **Not working** with the error's first line, keeps it **out of routing**, and prints `pacer account test terastorai` to retry. |
| Name taken | Offers `pacer account edit terastorai`. |

**Non-interactive form**, for scripts:

```
pacer account add endpoint terastorai --base-url https://api.terastor.ai/v1 \
  --key keychain|env:VAR|none --models qwen3-coder-480b --usage unmetered [--no-test]
```

With `--key keychain` or `file`, the key is read from stdin, so it never appears in shell history or the process list.

### 5. State the user can see

`pacer account list`, the dashboard, the app and the Orca panel show one state per endpoint account:

- **Ready**: the last test task passed. Shows its time.
- **Not tested**: the account was added with `--no-test`.
- **Not working**: shows the reason, e.g. "key refused", "endpoint unreachable", "model not found", "test task failed: <first line>".
- **Key missing**: the Keychain item, the file or the env var is gone.
- **External OpenCode provider**: a legacy account with no `connection`.

Routing excludes **Not working** and **Key missing** runners, with the reason shown in `pacer route`. That's the same mechanism used for an exhausted account.

### 6. Edit, test, remove

- **`pacer account edit <name>`** changes the base URL, the key, the models or the usage.
  - For an external account, it offers to **adopt** it:
    1. it shows which provider in the user's OpenCode config the account uses;
    2. it reads that provider's `baseURL` and model list;
    3. it asks for the key again. It never copies a literal key out of the user's config.
  - From then on, pacer manages the provider.
- **`pacer account test <name>`** reruns the connection check and the test task, then updates the state.
- **`pacer account rm <name>`**:
  - refuses while a runner uses the account, as it does today;
  - otherwise removes the provider from the generated config and asks whether to delete the stored key (Keychain item or file).
  - It never deletes a key referenced as an env var.

### 7. The app and the API

The app's **Add executor** wizard runs the same flow through v2 operations. The CLI flow calls the same core functions.

| Op | Params | Result |
|---|---|---|
| `account.models` | `{base_url, key?, name?}` | `{models: [{id, name?, context?, output?}], listed: boolean, error?}`. With `name` and no `key`, uses the stored key. |
| `account.add` | adds `{kind: "endpoint", name, usage, base_url, key_source: keychain\|file\|env\|none, key?, env_var?, models: [{id, name?, context, output, tools}], test?: boolean}` | `{account, runner, state}`; with `test` (default true) it runs the test task before returning |
| `account.edit` | `{name, base_url?, key_source?, key?, env_var?, models?, usage?}` | `{account, state}` |
| `account.test` | `{name}` | `{state, detail, checked_at?}` |
| `account.adopt` | `{name, key_source, key?, env_var?}` | `{account, state}`; reads the user's OpenCode provider's `baseURL` and models, never its key |

- The key travels once, in the request body over loopback, to the daemon. It is written straight to its store and never returned, logged, put in an event or kept in memory after the call.
- `account.list` adds `connection: {api, base_url_host, key: "present"|"missing", models, checked_at}` and `state` for endpoint accounts.
- `account.test` and `account.add` with `test` take up to the test task's timeout (2 minutes); the app shows progress and keeps the wizard open.

### 8. Security

- Keys are never written to `strategy.yaml`, the generated OpenCode config, task records, logs, link files, events, op results or any client.
- Keys exist only in their store and in the environment of the OpenCode process pacer launches for a task.
- The test task and launches pass the key through the environment, not argv.
- `pacer doctor` (and `account list --json`) report only whether a key is present (`key: present|missing`), never its value or length.
- The generated config is mode 0600 and lives in `~/.pacer/opencode/`, mode 0700.

## Not in this version

- Anthropic-compatible and other non-OpenAI APIs.
- Writing to the user's own OpenCode config (`export-opencode`).
- Per-model routing within one account. One runner per account, with one model. A second model needs a second account entry today; reconsider if users ask.
- Reading usage from the endpoint (for example `/usage`). Metered budgets keep using pacer's token counting.

## Testing

**Unit:**
- Connection parsing and validation.
- Generated-config rendering. Snapshot tests check that no key value appears in it.
- Model-list parsing for OpenAI, vLLM, LM Studio and Ollama response shapes.
- Key stores, with a fake `security` binary and a temp `HOME`.

**Integration:** a fake OpenAI-compatible server on loopback. It serves `/models` and `/chat/completions` and can return 401, a missing `/models` or a 500. The full `account add` flow runs against it, including a real `opencode run` with `OPENCODE_CONFIG`. HOME and PACER_HOME are isolated, and the pacer service is stubbed.

**Real**, before the PR is called done:
1. Add terastorai through the app on the user's Mac.
2. Delegate a real task to it.
3. Confirm `~/.config/opencode/opencode.json` is unchanged (checksum before and after).
4. Grep `~/.pacer` for the key and find nothing.
5. Repeat with a local LM Studio model (`--key none`).

The exact terminal session is recorded and attached to the PR.

## Decisions (2026-10-15)

1. **API**: `openai-compatible` only in this version. If terastorai turns out to be Anthropic-compatible, that API is added as a follow-up; the flow and state model do not change.
2. **Key store**: the macOS login Keychain by default on macOS, a 0600 file on Linux; `env:VAR` and `none` everywhere.
3. **Routing position**: a new executor goes to the end of the default rule and is moved in the app's Executors screen (or `routing.set`).
4. **Test task**: a fixed prompt in a temporary git repo ("create `hello.txt` containing `ok`"), 2-minute timeout, checked by the file's content. It never runs in the user's repos.
