# OpenCode endpoint setup: detect, recommend, confirm

Status: approved by the maintainer on 2026-10-20. Builds on [Endpoint executors](2026-10-15-endpoint-executors-design.md) and depends on the account/executor defect fixes (wizard re-prompting, shared sign-in state).

## Problem

Setting up an OpenCode endpoint executor today means answering questions the user cannot answer well. In a live setup of a BytePlus Coding Plan endpoint:

- The model list had 60 unfiltered entries, including image, video and embedding models that cannot run as an executor.
- "Usage (quota, metered, unmetered)" was unexplained.
- Metered usage asked for a weekly token budget, a number nobody knows.
- The quota source `arkcli` was suggested but not installed, and a blank answer was saved as an empty value.
- Key storage was not offered on add.
- Any invalid answer aborted the wizard and lost every earlier answer.

Meanwhile most users have already set providers up in OpenCode, and pacer ignores them.

## Goal

Three cases, in priority order:

- **A. Providers already signed in to OpenCode** (e.g. OpenRouter, a custom provider in `opencode.json`). Zero input: pick the provider, accept the model, done. No URL, no key.
- **B. Providers in the catalog the user has not connected** (e.g. DeepSeek, BytePlus, Zhipu). OpenCode stores the key; after that it is case A.
- **C. Local servers** (Ollama, LM Studio). Pick the server, accept the model, done.

A custom URL (TeraStor, international BytePlus, anything not in the catalog) remains as the fallback, using today's pacer-managed connection.

Success means:

- After choosing "Model endpoint (OpenCode)", case A needs one choice (the provider); every later prompt (model, cap, name, test) accepts its default on Enter.
- The model list never shows a model that cannot call tools or does not produce text.
- The user is never asked for a token budget. Spend is shown in dollars and an optional weekly dollar cap is the only budget question.
- No invalid answer aborts the flow; every prompt validates and re-asks.
- pacer never reads OpenCode's keys or `auth.json`.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | One core setup module serves the CLI wizard, the API and the app. | The CLI and app drifted apart before; one implementation prevents it. |
| D2 | For A and B, pacer **refers to** the OpenCode provider and never copies its key. | Copying would break the rule that pacer never reads native credentials (security rules). Rotating a key in OpenCode then just works. |
| D3 | For B, key entry is handed to `opencode auth login <provider>`. | OpenCode owns the key, like Claude Code owns `/login`. |
| D4 | C and custom URLs keep the pacer-managed `connection` from the 2026-10-15 spec. | Keeps that spec's security model (Keychain/file/env, redaction) where pacer must own the key. |
| D5 | Usage type is set from catalog data; the user is asked only when the catalog has no answer. | Most users cannot classify their provider. |
| D6 | Spend is read in dollars from `opencode stats`; the only budget is an optional weekly dollar cap. Tracking is always on. | Users think in dollars, and OpenCode already computes cost. |
| D7 | pacer recommends one model and the user confirms; other models are searchable. One executor per setup. | Keeps the first run to "press Enter". Adding more models stays a one-liner. |

## Design

### 1. Units

All cases run through `src/core/opencode-setup.ts`. The CLI wizard, the API ops and the app call it.

| Unit | Job | Depends on |
| --- | --- | --- |
| **catalog** (`src/endpoints/catalog.ts`) | Fetches the models.dev catalog (the data OpenCode uses) and caches it for 24 h in `~/.pacer/cache/models.json`. Answers: for provider X, its kind, env var, and models with tool calling, modalities, cost and limits. Offline it uses the stale cache; with no cache it returns `unknown`. | network, cache file |
| **detect** | Builds the candidate list. A: providers from `opencode auth list`, plus providers defined in the user's `opencode.json` (names and ids only). B: catalog providers not in A. C: a 1 s probe of `localhost:11434` (Ollama) and `localhost:1234` (LM Studio). Marks providers that already have a pacer account as "added". | `opencode` CLI, catalog, fetch |
| **recommend** | Keeps models with text input and output and tool calling, and drops embedding, image, video and speech models. Ranks by coding fitness (catalog flags, context size, release date). Returns one pick and the filtered rest. | catalog |
| **classify** | Sets the usage type. Local servers: unmetered. Known coding plans or $0-cost providers: quota, with the quota source set when a reader exists. Everything else: metered, with catalog prices for display. | catalog |
| **setup** | Runs the steps: candidate → (B only) `opencode auth login` → model → optional cap → name → save → test task. Each step returns a typed result or a field error, so callers re-ask instead of aborting. | the units above, `src/core/endpoints.ts` |

Without catalog data for a provider (custom providers in `opencode.json`, or catalog offline with no cache), the model list comes from `opencode models` (A) or `GET /models` (C, custom URL). It is filtered only by id patterns: `embed`, `image`, `tts`, `whisper`, `vision`. The list is labelled "unfiltered (catalog offline)" when the catalog is unavailable, and the usage question is asked with a one-line explanation of each type.

### 2. The flow

**Terminal.** `pacer account add` → **3. Model endpoint (OpenCode)** shows a picker built from detection:

```
$ pacer account add
> 3
Looking for models you can use…
  Already signed in to OpenCode
    1. OpenRouter            metered · prices known
    2. TeraStor AI           custom provider in your opencode.json
  Running on this machine
    3. Ollama (localhost:11434)   4 models · free
  Connect a provider (OpenCode stores the key)
    4. Search 90+ providers…      e.g. deepseek, byteplus, zhipu
  5. Enter a URL yourself
> 1
Model: qwen/qwen3-coder (tools, 262K context, $0.22/$0.95 per M)  [Enter to accept, / to search 41 others]
>
Weekly spend cap in $ (Enter for no cap)> 10
Name [openrouter]>
Test with a short task now? Uses about 2K tokens (≈$0.001). [Y/n]>
  Running opencode#openrouter … done in 7 s.
Ready: opencode#openrouter (qwen/qwen3-coder) · cap $10/week
```

- **A**: no key, no URL.
- **B**: search the catalog, then pacer runs `opencode auth login <provider>` in the same terminal and OpenCode asks for the key. pacer never sees it. On success the flow continues as A.
- **C**: no cap question, because the model is free.
- **Custom URL**: today's flow with the defect fixes: URL, key, key storage (keychain, file, env:VAR, none), the filtered model list, then the usage type with a one-line explanation of each.

Rules on every path:

- Each prompt validates when answered and re-asks on bad input. Nothing is saved before the test step.
- A failed test saves the account as **Not working** and keeps it out of routing, as today.
- Providers that already have an account are listed as "added", not hidden.

**App.** Add executor → OpenCode shows the same three groups as cards, from the same core result. For B, the browser cannot run an interactive CLI. The app shows the `opencode auth login <provider>` command to run in a terminal and a Refresh button that looks for the provider again; once OpenCode is signed in, the card moves to "Already signed in" and the flow continues as A. (Passing a key on stdin was considered, but it could not be confirmed without changing a real OpenCode login, so this release asks for no key at all. `executor.setup.connect` returns the command and runs nothing.)

**Non-interactive:**

```
pacer account add opencode <provider> [--model <id>] [--cap-usd <n>] [--name <name>] [--no-test]
```

Without `--model`, the recommended model is used. The existing `pacer account add endpoint …` forms stay for custom URLs.

### 3. Stored data and spend

```yaml
accounts:
  openrouter:                 # A or B: refers to an OpenCode provider
    kind: endpoint
    source: opencode          # new; no connection, no key
    provider: openrouter      # OpenCode provider id
    usage: metered            # set by classify, editable
    budget: {weekly_usd: 10}  # optional; omitted = no cap
  ollama:                     # C and custom URLs: the managed shape, unchanged
    kind: endpoint
    usage: unmetered
    connection: {api: openai-compatible, base_url: http://localhost:11434/v1, key: none, models: [...]}
```

- The runner model for `source: opencode` is `<provider>/<model>`. pacer launches OpenCode with its generated config as today; OpenCode merges it with the user's config and resolves the key itself.
- Accounts without `connection` and without `source` (today's "External OpenCode provider") are treated as `source: opencode`, with the provider taken from the runner model. No file rewrite is forced.

**Spend.** `src/usage/metered.ts` already runs `opencode stats --models --json --days 7`. It adds `--cost` and reads each model's dollar cost.

- With `budget.weekly_usd`, the reading has a window named `7d $` with used percent = cost ÷ cap. Pacing treats it like any other window.
- With no cap, the reading reports the spend ("$3.20 this week") and has no paced window.
- `budget.weekly_tokens` keeps working. `pacer account edit` offers to switch to a dollar cap; nothing migrates automatically.
- Catalog prices are only used for estimates shown before choosing a model.

**Quota.** The quota source is set automatically when a reader exists (BytePlus → `arkcli`). If the reader tool is missing, the reading says "usage unknown — install arkcli for live quota" and the executor still runs.

**Read model and API (additive, per the api-protocol rules):**

- Account summaries gain `spend_usd_week` and `cap_usd_week`, both nullable.
- New ops `executor.setup.candidates` (the section 1 detection result) and `executor.setup.models` (recommend result for one candidate).
- `account.add` accepts `{kind: "endpoint", source: "opencode", provider, model, cap_usd?, name?, test?}`.
- The catalog cache is read locally; read-model paths never fetch it.

### 4. Errors and edge cases

| Situation | Behavior |
| --- | --- |
| `opencode` not installed | The picker offers only "Enter a URL yourself" and says installing OpenCode unlocks the rest. Custom URLs still need `opencode` to run, so it warns once. |
| `opencode auth list` fails or is unparseable | Treated as no signed-in providers, with a one-line note. B and C still show. |
| Catalog unreachable, no cache | A and C work with unfiltered model ids, labelled as such. The usage question is asked. |
| Provider not in the catalog | Models from `opencode models`, filtered by id patterns; the usage question is asked. |
| `opencode auth login` cancelled or fails | Back to the picker; nothing saved. |
| Recommended model fails the test | Saved as Not working, out of routing. pacer offers the next recommendation (one key) or `pacer account test <name>`. |
| Provider later signed out of OpenCode | Found at the next run check (absent from `opencode auth list`). State **Key missing — run `opencode auth login <provider>`**; routing shows the same reason. |
| Local server not running at launch | Executor down with "Ollama not reachable at localhost:11434", like other endpoint failures. |
| Weekly cap reached | Treated like a full window: skipped until spend falls below the cap or the window moves on. The app shows "cap reached ($10/$10)". |
| Name taken | Suggests `<provider>-2`, or offers `pacer account edit`. |

**Security.**

- In A and B, pacer never reads `auth.json` or a key. It runs only `opencode auth list`, which prints provider names and "stored".
- In the app's B path, pacer never sees the key: the user signs in through `opencode auth login` in a terminal. `executor.setup.connect` runs nothing; an optional `key` param is accepted for later releases and never used, logged or stored.
- Custom URLs keep today's Keychain, file or env storage and redaction.

### 5. Testing

Unit tests (bun:test, test-first):

- `catalog`: parsing a recorded models.dev fixture in `test/fixtures/`, the 24 h cache, the stale fallback, the offline `unknown` result.
- `detect`: recorded `opencode auth list` and `opencode models` output; local server probes with a fake fetch; "added" marking.
- `recommend` and `classify`: table tests for BytePlus (60 models down to the tool-capable text models), OpenRouter (hundreds), Ollama, and a provider missing from the catalog.
- Wizard: scripted answers for A, B, C and a custom URL, including re-asks and a cancelled `opencode auth login`.
- Metered usage: reading `cost`, the `weekly_usd` percentage, and `weekly_tokens` still working.
- API: the new ops and fields are additive; the protocol doc is regenerated.

Live validation (CT-11) in a `bun run live` sandbox:

- A with OpenRouter, already signed in to OpenCode, through the CLI and the app.
- C with Ollama if it is running; otherwise UNVERIFIED.
- A custom URL with TeraStor.
- B: the CLI hand-off only. Storing a real new key needs the maintainer's go-ahead, so it is UNVERIFIED by default.
- One real test task per executor, a few thousand tokens each.

### 6. Rollout

1. Catalog, detect, recommend, classify and the dollar spend reading. No visible change on their own.
2. The CLI wizard and `pacer account add opencode`.
3. The API ops and the app's Add executor screen.
4. Docs: `docs/accounts.md`, `docs/executors.md`, the CLI reference, and a note in the 2026-10-15 endpoint spec that pacer now refers to OpenCode providers instead of adopting them.

Implementation starts from `main` after the account/executor defect fixes are merged.

## Out of scope

- A recommended pair of models (cheap and strong) wired into routing.
- Anthropic-compatible custom URLs.
- Writing to the user's `opencode.json`.
- Spend history beyond 7 days.
- TUI wizard screens; the TUI hands account setup to the CLI.
