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

To validate the Rust front door, add `--front-door rust` to `up`. The harness builds `target/debug/pacer` and runs it for the service and for every guarded `pacer` call, with `PACER_CORE_ARGV` pointing at this checkout's `src/cli.ts`. The service is then two processes: the front door (`pid`, bound to `innerPort`) and its `pacer-core serve --internal` child on a private ephemeral port, restarted by the front door if it exits. Both write to `logs/serve.log`; core lines are the core's own output, and front-door lines start with `pacer:` (for example `pacer: core did not announce its listener`). Find the child with `pgrep -P <pid> -f 'serve --internal'`.

For unseeded sandboxes, `HOME` stays unchanged so installed executors keep their authentication and usage readers see actual usage. The harness never reads or copies native tool credentials. `PACER_HOME`, `PACER_PORT`, `PACER_BIN`, `PACER_BACKEND=direct`, `PACER_NO_UPDATE_CHECK=1` and `PACER_ORCA_USER_DATA` select sandbox state. A minimal sandbox strategy initially routes to Codex; edit only the sandbox's `home/strategy.yaml` when testing other installed executors.

**Never run live work against the user's checkout or real `~/.pacer`.** Use the disposable `repo/` for delegations. Never copy the user's pacer strategy, account homes or credentials into evidence. Real executors spend real subscription or paid budget. The harness does not start an executor until you request a delegation.

Use `live pacer -- ...` for commands: it sets the working directory to the disposable repo, records output and propagates the exit code. For tools that need exports, `bun run live env --id my-change` prints shell-safe exports (also saved in `env.sh`):

```sh
eval "$(bun run live env --id my-change)"
```

Use those exports in a dedicated shell so later work does not inherit the sandbox. The guarded `pacer` stays first on `PATH`, and `PACER_BIN` points at it. Each guarded call reapplies sandbox env, including calls made by child tools. Do not bypass the wrapper or override the sandbox coordinates.

The D3 guard exits **3** with a named rule for `install`, `uninstall`, `init`, `setup`, `statusline`, `update`, `service install|uninstall`, `plugin uninstall|remove`, `account add|rm|login`, `host setup`, `orca`, and `open` without `--print`. Shadow `launchctl` and `systemctl` binaries also refuse service-manager access. This is an operational guard for cooperative validation, not a security boundary for arbitrary executor code. D8 below guards network API operations. Keep tests within the stated sandbox scope.

## D8: service operation guard

Every network client (CLI/API, web/tray, TUI and desktop) uses the public proxy port. Do not call `innerPort` directly. The proxy forwards `/app/` assets, cookies and Set-Cookie, SSE chunks and session WebSocket text/binary frames. It rewrites Host to the inner loopback authority and rewrites Origin only when it matches the public loopback origin; foreign and missing Origins remain unchanged for normal upstream rejection. Authentication and `X-Pacer-Client: app` checks still apply. Refused WebSocket handshakes preserve upstream HTTP status, headers and bounded response bodies. Oversized, truncated, timed-out or chunk-framed refusals return 502; Bun exposes raw chunk framing on rejected upgrades, so the harness does not relay those bodies.

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

`setup.init` is **allowed**: `setup.init` in `src/core/setup.ts` creates only `PACER_HOME/strategy.yaml`, or calls `config.set` with `integrations: "skip"`. Detection reads installed tools; it does not install integrations. Endpoint provider config regeneration itself is under `PACER_HOME/opencode`; account edit/adopt remain refused because their key paths can use the real Keychain. `host.add`, account mapping and repo mapping are conservatively refused even though their immediate config edits are sandbox-local: they enable later work on real hosts. Read-only operations and sandbox state changes remain available. Legacy delegation remains cooperative; new managed work requires strict native child control. Use only the disposable repository and do not register outside repos or add remote runners. This filter is not isolation for arbitrary executor code.

`terminal.list`, `terminal.rename` and `terminal.close` are allowed in the sandbox. `terminal.create` is allowed only for a shell whose canonical working folder is inside the disposable `repo/` or `home/`; other folders and app actions that launch external login, planning or SSH processes remain refused. Validate a harmless shell command in the disposable repository through the public proxy, then close the tab. Do not bypass D8 to exercise refused actions.

### Seeded Diagnostics repair

A `--seed ui` sandbox permits one additional operation: `agent.connect` for the fixed
`codex#team` fixture, through `/v3` with explicit consent and the current
`agent.preview` revision. The proxy verifies the recorded live service identity,
selected account, exact preview paths and sandbox-owned file tree. External paths,
symlinks, hardlinks, changed accounts, stale revisions, other agents and unseeded
sessions remain refused. Normal service authentication and Origin checks still apply.
The Codex installer only edits fixture files; it launches no agent or service manager.

To validate Diagnostics, change the sandbox's `home/accounts/team/AGENTS.md`, run
checks, review Repair, and apply it. Confirm that the integration check passes after
the automatic recheck. Inspect `home/install-manifest.json` and the fixture files;
record both success and refusal/error recovery. This permission does not apply to
real agent homes or any other D8 operation, and does not authorize executor launches.

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

The fixed scenario names are `upgrade`, `startup-failure`, `helper-crash`, `interrupted-install`, `restore-failure`, `adopt`, `adopt-failure`, `attached`, `takeover`, `takeover-relink`, `takeover-dismiss`, `takeover-failure`, `takeover-crash`, `wrong-service`, `watcher-race`, `active-work`, `invalid-signature`, `corrupt-archive`, `wrong-architecture`, `incompatible`, and `offline`. Commands, feed URLs, signing keys, and arbitrary service targets are not accepted as scenario options.

Managed native scenarios require `ota build` and a fresh harness service with recorded PID, birth and boot identity. The driver verifies immutable bundle bytes, ad-hoc signatures, exact compiled fixture policy and scoped native job inspection before handing off that one service process to the fixture desktop. It binds the native installation ID independently from signed bundle coordinates and the inspected registration, then observes the default automatic check/download and sends explicit restart through the public guarded proxy. If automatic download was already disabled, check and download also use that proxy. Only one exact recorded request is authorized while the driver incarnation remains alive. D3, unrelated D8 operations and all real service targets remain blocked. Missing or uncertain proof refuses and records UNVERIFIED. A failed baseline startup can reuse its signed fixture only when no exercise or request was armed and the former driver, source service and desktop incarnations have all exited. The native service and immutable bundle are verified again before a new driver claims the startup under the ledger lock; previous identities remain in evidence. An armed or ambiguous transaction cannot use this retry.

`upgrade`, `startup-failure`, `helper-crash`, `interrupted-install`, `restore-failure`, `adopt`, `adopt-failure`, `attached`, `takeover`, `takeover-relink`, `takeover-dismiss`, `takeover-failure` and `takeover-crash` have fixed compiled fixture checkpoints. No command, environment variable or API parameter selects a fault. A marker is consumed durably once before the fixed effect; `interrupted-install` occurs before commit and must restore the original version. Other scenarios remain unavailable until their constrained driver is implemented. This implementation is not evidence that a native scenario passed: use the actual evidence report. Production builds compile out fixture authority and fault hooks.

The attached scenarios start from an external service instead of the bundled one. `ota build` also stages one standalone copy of the baseline CLI and its native shim under `ota/external/`, recorded by hash in the ledger. The compiled helper's fixed attach operation registers and loads that program under the lease's service label before Desktop starts, so Desktop sees an attached installation. `adopt` sends the explicit adoption through the guarded proxy and requires a committed adoption journal, a managed-branch readiness proof, the bundled CLI as the surviving service, and the expected new installation ID. `adopt-failure` fails the bundled service's readiness once through a compiled fault and requires the original registration, external service and installation to be restored. `attached` performs an app-only update and requires the exact external service incarnation and registration bytes to be unchanged. The native ledger permits the service label to switch only between its two cataloged registrations, only after the old job is absent and every recorded incarnation has exited, and keeps each superseded generation in history.

### Service takeover fixture

Build each takeover scenario from a fresh sandbox with `bun run live ota build --id <id> --signer cert`. The certificate SHA-1 is compiled into the lease. The build records two ordinary standalone CLIs without native OTA authority or fixture policy, signed ad hoc and hashed in the lease ledger. The fixed `--ota-fixture-attach-takeover` helper registers only `<fixture home>/.local/bin/pacer`, copied from the staged candidate CLI. The second CLI supplies a changed identity for the dismissal probe. Preflight must prove that this regular file fails the lease's static release verification before the desktop starts. Consent has `keep: false`; no symlink is seeded. The real service label, terminal command and data home are excluded.

`takeover` confirms replacement of the detected service before the version gate and requires a committed takeover journal, a bundled service, available desktop update status, unchanged user data and original command bytes, and no relink. `takeover-relink` also requires a timestamped backup and a symlink to the bundled CLI. `takeover-dismiss` requires **Not now** to persist for the same executable identity and a changed binary to re-offer the choice. `takeover-failure` consumes the compiled `takeover-startup` checkpoint and requires restoration of the original registration and running executable identity. `takeover-crash` consumes `takeover-switch`, exits the helper after the registration switch, and requires the independent recovery job to restore the original service. When the source-built CLI remains the service (`takeover-dismiss`, `takeover-failure`, `takeover-crash`), the driver ends its own fixture desktop before completing, and cleanup stops only that exact verified service, because the CLI has no OTA authority to acknowledge fixture cleanup. Each journal step records `outcome` (`ok` or `failed`); restored and recovery-failed journals carry a short public reason code such as `verify:unavailable` or `interrupted:switch-registration`. Record native and VoiceOver surfaces not exercised as UNVERIFIED.

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
main/tray window IDs. Clients that do not opt in and v2 registrations receive
no capture credential; v3 rejects capture opt-in from non-desktop clients.
Window captures may fall back to an explicitly labelled
external capture; content captures never substitute a different surface.

Native macOS input and VoiceOver checks require Accessibility and screen recording
permission. `live doctor --surface desktop --request-accessibility --json`, or
**Settings → Diagnostics → Enable native checks**, opens System Settings and a
draggable hosting-app chip. The chip follows the selected Settings window without
AX access, remains visible across focus changes, and verifies a read of the exact
owned desktop window before setup succeeds. Missing native or speech evidence is
reported as UNVERIFIED.


## Disposable CLI updater validation

`bun run live up --id bridge-update --seed ui`, then `bun run live updater --id bridge-update`, exercises the compiled CLI updater against fixed loopback releases. This is the approved bridge-plan fixture (the companion is a copy of the compiled binary), not a paired Rust release or desktop OTA test.

The command accepts only an explicit sandbox ID. It refuses unseeded/stopped sessions, noncanonical/symlinked or unowned directories, group/other-writable paths, and an existing fixture directory. It compiles synthetic0.0.1/0.0.2 builds from the checkout into the sandbox and uses new private install, HOME, config and temporary directories for each scenario. It supplies fixed `--no-restart --no-reinstall` flags and accepts no binary paths, release URLs, commands or scenario overrides. Ordinary D3/D8 update refusals remain unchanged.

The six fixed checks cover an existing pair, adding the companion, a legacy manifest, checksum refusal, smoke refusal, and restoring the previous core after a front-door commit failure. The last case uses a controlled script that removes only its own known staged fixture path during its version probe; it induces a real rename failure after core installation. Expected refusals count as PASS only when the exact error, unchanged installed bytes/versions and cleaned staging files are observed. Successful updates require new versions and exact previous-byte backups. This proves the transaction path; it does not certify interruption recovery, real service restart, integration refresh, production signing or distribution.

On macOS the real updater consults read-only code-signing identity metadata. The fixture checks before and after every scenario and refuses when the normal local signing identity exists, so it cannot deliberately use that private key. This is a cooperative test assumption, not protection against a concurrent same-user keychain change. Bun's ad-hoc fixture signatures are not production signing evidence. Compilation uses an isolated environment and does not invoke the local signing helper.

Results are recorded in the session report and `updater/<scenario>/result.json`. Run `live report` then `live down --keep` to retain evidence. There is no general update allow flag or permission to use a real installation as a fixture.

## Disposable integration refresh fixtures

`bun run live up --id integration-refresh`, then
`bun run live integrations --id integration-refresh`, exercises the checkout CLI
and real service startup against default and named account folders inside a
private fixture. The command accepts only an explicit active unseeded sandbox ID;
paths, commands and environment overrides are refused. It uses private HOME,
PACER_HOME and agent configuration directories and never reads or copies native
credentials, invokes a service manager or signs an agent in. Existing fixture
directories are preserved rather than reused.

Fixed checks cover old-but-intact assets at startup, health availability, named
account targeting, repeat startup without manifest writes, unrelated settings,
customized-file conflicts and retry after conflict resolution. Evidence is added
to the session report. This file-only fixture does not certify real executor
consumption, native hook invocation, remote hosts or native trust approval; record
separate evidence for applicable launch paths. Ordinary guarded
`integrations refresh` calls are refused under D3. Finish with `live report` and
`live down --keep`.
