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
| `desktop.update.*` | all desktop update operations except status require a verified OTA fixture |
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

Open the printed single-use `/app/auth?code=...` URL in your own browser MCP tool. The URL expires quickly; request another if it was already consumed or expired. Inspect the relevant screens, actions, loading/error states and tray popover view (the `/app/tray.html` URL after login). Attach screenshots and record observations. The harness has no Playwright dependency. Browser rendering alone does not verify native desktop tray behavior.

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

## Disposable desktop OTA fixtures

OTA preparation is an explicit harness mode. Use two disposable build bundles inside this checkout, such as builds copied under `.work/fixtures/`; never pass an installed app. The harness refuses sources outside the checkout or inside the destination sandbox, equal/overlapping sources, escaping symlinks, default service ports, and unowned or symlinked sandbox resources. Relative framework links whose targets stay inside their bundle are preserved.

```sh
bun run live up --id ota-check
bun run live ota prepare --id ota-check --from-app .work/fixtures/old.app --to-app .work/fixtures/new.app
bun run live ota exercise --id ota-check --scenario upgrade
bun run live ota cleanup --id ota-check
bun run live report --id ota-check
bun run live down --id ota-check --keep
```

`prepare` records a private resource ledger under `ota/record.json` before copying either app. It allocates separate current/candidate copies, a sandbox installation ID, and unique reserved service/recovery labels. It fingerprints both sources and the existing real service registration bytes without copying the registration into the fixture. Preparation never invokes a service manager or launches a native application. Cleanup of copies that have never been exercised does neither. Cleanup validates the ledger and canonical ownership again, removes only the recorded copies, and verifies that the sources and real registration bytes are unchanged. Unexpected resources, changed sources/registration, or unknown registration ownership preserve the sandbox for diagnosis. Generic `down` runs this validation before tearing down an OTA sandbox; `--keep` preserves the ledger and evidence.

On macOS, `bun run live ota build --id <id>` can instead build the complete disposable baseline0.2.3 and candidate0.2.4 from isolated source snapshots. It reserves an immutable compile lease in phase `building`, uses a newly generated disposable Tauri key and explicit ad-hoc Apple signatures, verifies compiled identities and the version-bound updater signature, then records exact feed/artifact fingerprints before marking `prepared`. The production checkout versions are unchanged. Only the host architecture is represented; no other architecture or production signing is claimed. This command accepts no key, command, feed, version, or manager target override. Incomplete builds remain preserved and cannot authorize runtime mutations. Cleanup retains immutable build sources and removes only recorded application copies and feed artifacts after registration ownership is settled.

The fixed scenario names are `upgrade`, `startup-failure`, `helper-crash`, `interrupted-install`, `restore-failure`, `adopt`, `adopt-failure`, `attached`, `wrong-service`, `watcher-race`, `active-work`, `invalid-signature`, `corrupt-archive`, `wrong-architecture`, `incompatible`, and `offline`. Commands, feed URLs, signing keys, and arbitrary service targets are not accepted as scenario options.

Managed native scenarios require `ota build` and a fresh harness service with recorded PID, birth and boot identity. The driver verifies immutable bundle bytes, ad-hoc signatures, exact compiled fixture policy and scoped native job inspection before handing off that one service process to the fixture desktop. It binds the native installation ID independently from signed bundle coordinates and the inspected registration, then observes the default automatic check/download and sends explicit restart through the public guarded proxy. If automatic download was already disabled, check and download also use that proxy. Only one exact recorded request is authorized while the driver incarnation remains alive. D3, unrelated D8 operations and all real service targets remain blocked. Missing or uncertain proof refuses and records UNVERIFIED. A failed baseline startup can reuse its signed fixture only when no exercise or request was armed and the former driver, source service and desktop incarnations have all exited. The native service and immutable bundle are verified again before a new driver claims the startup under the ledger lock; previous identities remain in evidence. An armed or ambiguous transaction cannot use this retry.

`upgrade`, `startup-failure`, `helper-crash`, `interrupted-install`, `restore-failure`, `adopt`, `adopt-failure` and `attached` have fixed compiled fixture checkpoints. No command, environment variable or API parameter selects a fault. A marker is consumed durably once before the fixed effect; `interrupted-install` occurs before commit and must restore the original version. Other scenarios remain unavailable until their constrained driver is implemented. This implementation is not evidence that a native scenario passed: use the actual evidence report. Production builds compile out fixture authority and fault hooks.

The attached scenarios start from an external service instead of the bundled one. `ota build` also stages one standalone copy of the baseline CLI and its native shim under `ota/external/`, recorded by hash in the ledger. The compiled helper's fixed attach operation registers and loads that program under the lease's service label before Desktop starts, so Desktop sees an attached installation. `adopt` sends the explicit adoption through the guarded proxy and requires a committed adoption journal, a managed-branch readiness proof, the bundled CLI as the surviving service, and the expected new installation ID. `adopt-failure` fails the bundled service's readiness once through a compiled fault and requires the original registration, external service and installation to be restored. `attached` performs an app-only update and requires the exact external service incarnation and registration bytes to be unchanged. The native ledger permits the service label to switch only between its two cataloged registrations, only after the old job is absent and every recorded incarnation has exited, and keeps each superseded generation in history.

Successful upgrade and restoration checks also require completed reservation
release and recovery-job retirement, followed by independent observation of the
exact Desktop and service incarnations in the readiness proof. A terminal journal
written before those processes disappear is insufficient evidence of success.

The deliberate `restore-failure` case leaves the service unavailable. Its driver
therefore requires an authorized terminal native journal, both consumed fault
receipts, the retained admission reservation and independently observed absence
of the service and desktop. It does not manufacture a public API response while
the service is down. Successful upgrade and rollback still require matching
public status and fresh native readiness proofs.

After a successful exercise, cleanup uses only the helper's fixed compiled-lease retirement operation. It reserves admission, verifies and gracefully closes exact native desktop peers, waits for their incarnations to exit, and retires only the ledger-owned jobs before removing disposable copies. Unknown processes or registrations, incomplete exercise, and `recovery-failed` preserve all resources for diagnosis. Keep data and recovery files in place; do not use a reinstall or an unscoped manager command as cleanup. Developer signatures cannot establish production signing, notarization, other-architecture or delivery evidence.

A fixture baseline that failed before becoming ready has a separate constrained cleanup path. It requires the original driver, source service and desktop to have exited, no update request or transaction ever armed, and exact signed diagnostics compiled for that same lease. The diagnostics reserve idle admission before retiring the unique recorded job; unavailable or uncertain proof preserves the sandbox. Diagnostic corrections retain prior binaries, descriptors and source fingerprints in an append-only history (at most four attempts). This mechanism accepts no arbitrary command, process, service label or build key, and is absent from production authority.

### Certificate-signed fixtures

`bun run live ota build --id <id> --signer cert` signs both fixture versions with a disposable self-signed code-signing certificate instead of ad hoc signatures. The certificate's SHA-1 is compiled into the fixture lease, so every native check also pins it, as an interim release build pins the project certificate. The private keychain is deleted after the build. Use it to exercise the interim signer's requirement strings end to end (`upgrade`, `startup-failure`, `adopt`). Cleanup diagnostics for a failed startup are unavailable for certificate-signed fixtures. A disposable certificate is not evidence for the release certificate, CI signing, Gatekeeper or the first-install flow.

## Agent control commands

The harness exposes a single JSON contract for `web`, browser `tray`, `tui` and
native `desktop` targets through `targets`, `inspect`, `act`, `wait`, `assert`,
`capture`, `scenario` and `doctor`. Actions carry target generations and revisions;
coordinate input additionally carries a recent capture ID. Delivered or uncertain
actions attempt an automatic evidence capture and are never repeated implicitly.

The ordinary desktop app opts in with `capture: true` on v3 `client.register`,
receives its per-instance `capture_worker` credential, and reports its owned
main/tray window IDs. Clients that do not opt in, non-desktop clients, and v2
registrations receive no capture credential. Window captures may fall back to an explicitly labelled
external capture; content captures never substitute a different surface.

Native macOS input and VoiceOver checks require Accessibility and screen recording
permission. `live doctor --surface desktop --request-accessibility --json`, or
**Settings → Diagnostics → Enable native checks**, opens System Settings and a
draggable hosting-app chip. The chip follows the selected Settings window without
AX access, remains visible across focus changes, and verifies a read of the exact
owned desktop window before setup succeeds. Missing native or speech evidence is
reported as UNVERIFIED.
