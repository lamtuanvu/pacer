# Live validation

CT-11 requires live evidence for runtime behavior changes. Use the checkout under review with a sandbox service, then exercise every affected surface. Unit tests support this check; a passing test suite alone does not establish live behavior. Docs-only, test-only and CI-only changes are exempt.

## Start and inspect a sandbox

From the checkout root:

```sh
bun run live up --id my-change
bun run live status --id my-change
bun run live pacer --id my-change -- status --json
bun run live login --id my-change
```

`up` creates `.work/live/my-change/` with a private pacer `home/`, a guarded `bin/pacer`, a disposable git `repo/` with an initial commit, logs and evidence. `--repo-template <dir>` copies a starting project, excluding `.git`, `.work` and `node_modules`, and creates a fresh git history. It never uses the template itself as the executor's working directory. IDs contain letters, digits, underscores or hyphens. Omitting `--id` selects the most recently created sandbox. An existing ID is never overwritten.

For UI inspection, opt in to synthetic sample data before the service launches:

```sh
bun run live up --id ui-check --seed ui
bun run live login --id ui-check
```

`--seed ui` completes the derived setup checklist and supplies five sample tasks: waiting for review, failed with a removed worktree, partial, running, and accepted/done. It also supplies task attention entries and quota readings for two accounts, reusing the UI fixtures in `test/fixtures/ui/`. The home (`#/`), review (`#/review`), sessions (`#/sessions`) and task detail routes can then display sample work. Unknown seed names are rejected before a sandbox is created; `--seed` is valid only for `up`.

All seed files are written under the sandbox's `home/`. In this mode only, `HOME` and tool config directories also point there. Synthetic account logs and empty login markers replace native account state. Status-only `launchctl`/`systemctl` stubs satisfy the setup check and refuse mutations; executor stubs refuse execution. These represent fixture readiness, not an installed service or authenticated accounts. The running task has no executor process, child PID or resumable run; PID 1 is used only as a liveness sentinel, never as a signal target. Use an unseeded sandbox for real executor validation. D3 and D8 still apply.

The service and D8 guard proxy run detached from this checkout on two different free loopback ports, neither 4317. `session.json` records the public `port`, private `innerPort`, service `pid` and `proxyPid`. All clients use the public port (`PACER_PORT`); only the service binds `innerPort` via `--port`. Startup verifies the proxy identity, inner service identity and forwarded `/health`. Inspect `logs/serve.log` and `logs/proxy.log` if startup fails. `bun run live status` lists all sandboxes, including stopped ones retained with `--keep`.

For unseeded sandboxes, `HOME` stays unchanged so installed executors keep their authentication and usage readers see actual usage. The harness never reads or copies native tool credentials. `PACER_HOME`, `PACER_PORT`, `PACER_BIN`, `PACER_BACKEND=direct`, `PACER_NO_UPDATE_CHECK=1` and `PACER_ORCA_USER_DATA` select sandbox state. A minimal sandbox strategy initially routes to Codex; edit only the sandbox's `home/strategy.yaml` when testing other installed executors.

**Never run live work against the user's checkout or real `~/.pacer`.** Use the disposable `repo/` for delegations. Never copy the user's pacer strategy, account homes or credentials into evidence. Real executors spend real subscription or paid budget. The harness does not start an executor until you request a delegation.

Use `live pacer -- ...` for commands: it sets the working directory to the disposable repo, records output and propagates the exit code. For tools that need exports, `bun run live env --id my-change` prints shell-safe exports (also saved in `env.sh`):

```sh
eval "$(bun run live env --id my-change)"
```

Use those exports in a dedicated shell so later work does not inherit the sandbox. The guarded `pacer` stays first on `PATH`, and `PACER_BIN` points at it. Each guarded call reapplies sandbox env, including calls made by child tools. Do not bypass the wrapper or override the sandbox coordinates.

The D3 guard exits **3** with a named rule for `install`, `uninstall`, `init`, `setup`, `statusline`, `update`, `service install|uninstall`, `plugin uninstall|remove`, `account add|rm|login`, `host setup`, `orca`, and `open` without `--print`. Shadow `launchctl` and `systemctl` binaries also refuse service-manager access. This is an operational guard for cooperative validation, not a security boundary for arbitrary executor code. D8 below guards network API operations. Keep tests within the stated sandbox scope.

## D8: service operation guard

Every network client (CLI/API, web/tray, TUI and desktop) uses the public proxy port. Do not call `innerPort` directly. The proxy forwards `/app/` assets, cookies and Set-Cookie, SSE chunks and session WebSocket text/binary frames. It rewrites Host to the inner loopback authority and rewrites Origin only when it matches the public loopback origin; foreign and missing Origins remain unchanged for normal upstream rejection. Authentication and `X-Pacer-Client: app` checks still apply.

Refused operations return HTTP **403** with the protocol error shape `{ "error": { "code": "forbidden", "message": "Live validation D8: <op> changes the real user environment" } }`. Every refusal appends a note to `evidence/log.jsonl`, visible in the report as UNVERIFIED. No request bodies, keys or cookies are recorded in those notes.

Refused buttons are expected, including Setup's **Connect** button. Record the UI path and refusal; mark the requested live side effects **UNVERIFIED**. A visible refusal can verify the guard, but cannot verify the installation, login, update or terminal action it prevented. Do not bypass the proxy to make that button succeed.

The policy source of truth is exported as `BLOCKED_OPS` from `scripts/live/proxy.ts`. The table is checked against that constant by `test/live-harness.test.ts`. Handler audit: `src/api/ops.ts` (both `/v2/ops/` and `/v3/ops/` dispatch there), plus `src/api/ops-session.ts` for attachment:

<!-- D8 policy -->
| Operation | Handler audit and reason for refusal |
| --- | --- |
| `agent.connect` | setup.agentConnect installs integrations in real agent homes |
| `service.install` | setup.serviceInstall registers a real launchd/systemd login service |
| `agent.disconnect` | setup.agentDisconnect reverts integrations in real agent homes |
| `account.signin` | accounts.signin / interactiveTerminal opens real terminals and login flows |
| `account.add` | accounts.add creates account homes; endpoints.addEndpoint may write Keychain keys |
| `account.remove` | accounts.remove may delete account homes and endpoint keys |
| `account.adopt` | endpoints.adoptEndpoint stores keys and regenerates provider config |
| `account.edit` | endpoints.editEndpoint stores keys and regenerates provider config |
| `host.add` | hosts.add enables remote execution outside the sandbox |
| `host.account.add` | hosts.addAccount maps real remote account homes |
| `host.repo.map` | hosts.mapRepo maps checkouts outside the sandbox |
| `host.repo.setup` | hosts.setupJob clones and changes remote repository identity |
| `host.terminal` | hosts.terminal opens a real SSH terminal |
| `update.apply` | applyUpdate may replace the installed binary and refresh integrations |
| `strategy.build` | buildStrategy opens a planning terminal in Orca, tmux or the OS |
| `config.set` | config.set can install and uninstall planner integrations (whole op refused conservatively) |
| `runner.add` | interactiveTerminal opens a real terminal (whole op refused conservatively) |
| `task.attach` | openSession can switch/create Orca terminals or split real tmux (whole op refused conservatively) |
| `host.clean` | hosts.cleanJob removes worktrees on remote hosts (whole op refused conservatively) |
| `plugin.remove` | plugins.remove deletes a plugin folder under the home (whole op refused conservatively) |
| `service.*` | all service operations except service.status can change the real login service |
<!-- /D8 policy -->

`setup.init` is **allowed**: `setup.init` in `src/core/setup.ts` creates only `PACER_HOME/strategy.yaml`, or calls `config.set` with `integrations: "skip"`. Detection reads installed tools; it does not install integrations. Endpoint provider config regeneration itself is under `PACER_HOME/opencode`; account edit/adopt remain refused because their key paths can use the real Keychain. `host.add`, account mapping and repo mapping are conservatively refused even though their immediate config edits are sandbox-local: they enable later work on real hosts. Read-only operations and sandbox state changes remain available. Real delegation is still cooperative: use only the disposable repository and do not register outside repos or add remote runners. This filter is not isolation for arbitrary executor code.

## Select the affected surfaces

Write down each changed behavior and its expected result before exercising it. Include error and recovery paths that the change affects.

| Changed paths | Required live exercise |
| --- | --- |
| `src/api/`, `src/serve/` | CLI/API operations against the sandbox service, plus web behavior that consumes them |
| `app/` | Web app and tray popover through browser MCP; inspect relevant desktop tray integration when affected |
| `src/dashboard/`, `src/render/` | TUI in tmux; inspect text layout, navigation and changed actions |
| `desktop/` | Built desktop app through computer-use, including affected window/tray behavior |
| `src/exec/`, `src/supervisor/`, `src/tasks/`, `src/remote/` | Real delegation into the disposable sandbox repo, wait for completion, inspect result and record review |
| Other runtime paths, including `scripts/live/` | Exercise the changed commands and all surfaces that consume the behavior |

Combine rows for changes spanning areas. Remote live tests still require separate maintainer authorization under SEC-6; local validation does not authorize SSH execution. If authorization or infrastructure is missing, report the remote surface UNVERIFIED.

## Drive the surfaces

### CLI and API

```sh
bun run live pacer --id my-change -- status --json
bun run live pacer --id my-change -- tasks --json
```

For direct API calls, use `http://127.0.0.1:<session.port>` and read the sandbox `home/token` without printing it into evidence. Write requests retain the normal Origin and client-header requirements. Do not include bearer tokens, endpoint keys or native authentication in notes, screenshots or attachments.

### Web and tray

```sh
bun run live login --id my-change --screen sessions
```

Open the printed single-use `/app/auth?code=...` URL in your own browser MCP tool. The URL expires quickly; request another if it was already consumed or expired. Inspect the relevant screens, actions, loading/error states and tray popover view (the `/app/tray.html` URL after login). Attach screenshots and record observations. The agent control adapter uses the existing playwright-core dependency with an installed Chromium browser. Browser rendering alone does not verify native desktop tray behavior.

### TUI

Install tmux separately if it is unavailable; the harness never installs tools.

```sh
bun run live tui start --id my-change
bun run live tui keys --id my-change Down Enter
bun run live tui capture --id my-change --out tui-tasks.txt
bun run live tui stop --id my-change
```

The session is named `pacer-live-my-change`, sized 120 by 40, with the sandbox environment passed explicitly even when tmux's server already exists. `keys` accepts tmux key names. Captures go under `evidence/` (`--out` selects a filename). The dashboard requires a TTY. Do not approve integration installers or external environment changes from the dashboard. The guarded CLI refuses `update`; the D8 proxy refuses `update.apply`. Capture the observed result of any affected update flow.

### Real delegation

Run this from a planner session: executor-role sessions must not delegate onward. Pick an installed executor and use a small task appropriate to the change. All repository paths in briefs and `--repo` must refer to the disposable `repo/`, never the checkout being reviewed.

```sh
bun run live pacer --id my-change -- delegate \
  --goal 'Create a small greeting text file in this disposable repo' \
  --acceptance 'test -f greeting.txt' --executor codex --wait --json
# Use the returned task ID; wait can also resume an observation after a timeout.
bun run live pacer --id my-change -- wait <task-id> --json
bun run live pacer --id my-change -- tasks <task-id> --json
# Inspect the result, run its acceptance command in the disposable repo, then:
bun run live pacer --id my-change -- review <task-id> --accept --json
```

Record the task ID, actual executor, acceptance output, result and review. Use `--reject` when the result fails acceptance. Stop active tasks with `live pacer -- stop <task-id>` before teardown: stopping the service does not stop independently running executors. Fake executors cannot satisfy real delegation evidence.

### Desktop

Build the app using [desktop/README.md](../../desktop/README.md), then:

```sh
bun run live desktop --id my-change
# Or choose a built .app bundle or its executable:
bun run live desktop --id my-change --app <path>
```

The default is the built app under `desktop/src-tauri/target/release/bundle/macos/`. The harness launches the executable directly with sandbox env, bypassing app-instance reuse by the OS launcher. A sandbox shell shim preserves the guarded PATH during desktop's login-shell discovery. Drive the new window with computer-use, confirm its service origin matches the sandbox port, and inspect changed window/tray behavior. Launch success alone is not a PASS. Missing builds, platform support or computer-use access mean UNVERIFIED.

## Record and report evidence

Commands run through `live pacer` are recorded with argv, exit code and output truncated to 16,000 characters per stream. Capture longer output separately if it matters. Other harness observations and captures share `evidence/log.jsonl`. It is private sandbox data; login URLs may appear there. Inspect and redact evidence before sharing it.

```sh
bun run live note --id my-change --behavior 'Task completion appears' \
  --surface web --steps 'Delegate; wait; refresh tasks screen' --verdict PASS \
  'Completed task and review action were visible after refresh.'
bun run live attach --id my-change <screenshot-or-output-file>
bun run live note --id my-change --behavior 'Native tray refresh' \
  --surface desktop --verdict UNVERIFIED 'No built desktop app was available.'
bun run live report --id my-change
```

`report` writes `.work/live/my-change/evidence/report.md` with a per-behavior table: behavior, surface, steps, observed result and PASS/FAIL/UNVERIFIED. Notes without a verdict default to UNVERIFIED. With no behavior notes, the report explicitly remains UNVERIFIED. Commands alone never imply a pass. Record a separate note for every required behavior/surface pair; do not omit untested pairs.

PASS means the expected behavior was actually observed. FAIL means it was exercised and the observed result differed. UNVERIFIED means it could not be exercised or the evidence was inconclusive; explain the missing tool, budget, authorization or infrastructure. A fallback observation must state which part it covers and which integration is UNVERIFIED. CT-11 leaves those parts outstanding; do not report the task as fully verified.

Summarize the report counts, behaviors, surfaces, task IDs and limitations in the result and PR's **How tested** section, along with unit/typecheck results. Link the report path for local review. Everything under `.work/` stays untracked.

## Tear down

Stop or finish delegated tasks and close the launched apps first, then:

```sh
bun run live report --id my-change
bun run live down --id my-change --keep
```

`down` stops the sandbox proxy, inner service and tmux session. `--keep` preserves the sandbox and evidence for review; without it, the entire sandbox is removed. A retained sandbox can be removed later with `down` without `--keep`. The service PID is checked against inner `/health` and the proxy PID against public `/__live/health` before signaling each; a live but unverified PID causes teardown to refuse rather than kill an unrelated process. If startup fails, inspect the retained logs and process state before deleting its directory.

## Agent control commands

The checkout harness exposes one JSON command contract for `web`, browser `tray`,
`tui` and native `desktop` targets:

```sh
bun run live targets --id my-change --surface web --json
bun run live inspect --id my-change --surface web --json
bun run live act --id my-change --surface web --action click \
  --selector '{"role":"link","name":"Settings"}' --json
bun run live wait --id my-change --surface web \
  --condition '{"role":"heading","name":"Settings"}' --timeout-ms 10000 --json
bun run live assert --id my-change --surface web \
  --condition '{"role":"button","name":"Check now"}' --json
bun run live capture --id my-change --surface web --json
bun run live scenario --id my-change --file scripts/live/scenarios/settings-updates.json --json
```

JSON results have schema major `1`, command/run IDs, timestamps, target identity,
observations, artifact references and structured errors. `outcome` describes the
command; `delivery` separately distinguishes `delivered`, `not_delivered` and
`unknown` inputs. Assertions use PASS/FAIL/UNVERIFIED. Never repeat an uncertain
mutation without inspecting its effects. Unknown additive response fields are
allowed; unsupported schema majors are rejected.

Inspection returns accessible controls with refs, revision and target generation.
A ref action needs all three (`--ref`, `--revision`, `--generation`); navigation,
replacement or changed state may invalidate it. A semantic selector must match
exactly one control. When names repeat, scope the selector with `within`, for example
`{"role":"link","name":"Updates","within":{"role":"navigation","name":"Settings sections"}}`. Coordinate clicks use image-pixel `--x`, `--y` and
`--capture-id`; stale image geometry is rejected. Browser control supports click,
type, key, select, scroll, resize and activate. Native capabilities are reported
by the adapter; unsupported controls produce explicit errors. TUI uses literal
text or named tmux keys, screen text and cursor state rather than DOM controls.

Each delivered/uncertain action attempts an automatic capture, including failure
paths. Terminal captures are text. Files go to `evidence/captures/`, detailed
steps to `evidence/steps/` and immutable source/binary metadata to
`evidence/provenance/<hash>.json`. Each step retains its own provenance reference;
`evidence/provenance.json` points to the latest document. Native self-capture
artifacts also retain capture-time PID, native window ID, application version and
executable hash, timestamp, viewport dimensions and scale. The harness checks
the producer against its owned desktop build/window before saving evidence.
The input deadline prevents late actions after expired preflight; follow-up
read-only capture gets a separate diagnostic budget of at most 10 seconds.
Input values are redacted from step requests, and browser password/OTP controls
are masked in screenshots. Review all evidence before publishing: other visible
text can still be sensitive. Captures alone do not establish a passing behavior.

### Browser ownership

The harness uses the existing `playwright-core` dependency and an installed
Chromium executable. Set `PACER_LIVE_BROWSER` to select one. The macOS default
is Google Chrome in Applications; Linux uses an installed Chromium/Chrome on
PATH. No browser is downloaded. The context has its own profile and logs in
through the sandbox public origin. Set `PACER_LIVE_HEADLESS=1` for headless use;
this remains browser evidence, not native desktop evidence.

`live browser start` starts the persistent owned context; control commands can
also start it lazily. `live browser stop` closes it. `down` closes the owned
browser before the sandbox service. If control sources change while a worker is
running, stop it before retrying; this prevents old observers claiming current
source provenance. A busy target refuses concurrent writers.

### Native prerequisites and capture

Build the ordinary desktop app, then use `live desktop --app <path>` and
`live doctor --surface desktop --json`. The macOS helper requires the installed
Swift compiler, an unlocked exclusive desktop session, Accessibility permission
for input/AX and screen capture permission for window images. The currently
measured compile host is macOS 27.0 with Xcode 27.1; external window capture uses
macOS 14+ APIs. Other native OS/SDK combinations remain unverified. The harness
does not grant permissions or close another Pacer instance to obtain a slot.
Launching an executable does not bypass Tauri's application singleton.

The normal desktop app supports `desktop.capture.*` on protocol v3. It reports
owned main/tray window IDs through its authenticated capture worker. Expired
worker credentials are renewed with the existing instance proof over the
service session; public client IDs cannot obtain another worker credential.
Renewal proof lasts for the current service lifetime and becomes invalid on
service restart. A newly registered desktop receives a new client ID. Transient
observer failures retry with bounded backoff without repeating UI actions.
PNG validation limits compressed images to 16 MiB, decoded data to 128 MiB and
each dimension to 16384 pixels. Binary uploads reserve one reader per request
and terminate after at most 10 seconds or request expiry. Native
`capture --mode window` defaults to OS window paint; `--mode content` takes a
WKWebView content snapshot. Content excludes titlebars and native dialogs.
Window capture may fall back to an explicitly labeled external window capture
with a warning retaining the self-capture failure. Content never silently replaces
required window evidence. Old app releases can be inspected externally by native
window ID but do not acquire self-capture by using a newer harness.

Native leases coordinate cooperating agents across worktrees. Foreground drift
and stale process/window identities refuse input. They do not prevent another
user or non-cooperating tool from moving the shared desktop. Use a dedicated
session for native scenarios. VoiceOver calibration, speech observation and
manual listening remain separate obligations; this interface does not turn AX
text or screenshots into speech evidence.
