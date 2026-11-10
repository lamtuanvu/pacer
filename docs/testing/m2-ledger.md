# M2 forwarded operation ledger

Native means Rust registers an operation and produces its reply for at least some valid requests; registrations that only validate parameters and forward every valid request whole to Core are Forwarded (Rust-validated). Selective is the subset of native operations whose own handler hands execution of the operation to TypeScript for some inputs, callers or on-disk states, either by forwarding the original request or by using a whole-operation bridge whose Core result becomes the reply. For example, admitted `task.send` requests are reconstructed and executed by Core. Bridges for effects or enrichment, where Rust still composes the reply, do not count; neither does process-wide routing, including work-grant processes forwarding everything and `PACER_FORWARD_OPS`. Plugin operations are native over HTTP and stdio; the nesting fallback is context-wide on both. The catalog is the v3 operation list in `stdio_hello.json`; catalog equals native plus forwarded.

**P7 replay gate (2026-11-06):** TypeScript `Screen` checkpoint roundtrip is **GO** on the synthetic vt100 corpus (`test/session-replay-gate.test.ts`). Native vt100 replay remains **NO-GO** (insert mode, SGR 9 strikeout, ZWJ width, disabled autowrap, and public-exporter scroll-region gaps). Keep session WebSocket and offline replay on the TypeScript host until a full native gate passes; `pacer-sessions` continues file/frame/control characterization only. Since 2026-11-09 the control characterization also mirrors the ADR 0023 delivery window (`deliver`/`granted`/`delivered`, quiet period, pending line, held input, `expired-unused`, `maxWindowMs`), checked against `test/fixtures/sessions/*-parity.json`; the TypeScript `ViewerHub` stays the runtime implementation.

**M2 wave 3 PR 7 gate (2026-11-12):** **RED**. The PR 6 consumer matrix and conformance subset pass except rows routed to security review, each with an expected-fail test: the flag-on assistant secret alias, Core auto-issuing a granted manifest's exact `net.http` hosts and exact `fs.read` paths for any owner call without host resources (`autoIssueFromManifest`), and owner refusal message text. The I1 row is green: `_run` runners no longer inherit `PACER_HOST_SOCKET` and own their plugin children, as flag-off (ADR 0027). The owner appends plugin stderr to the plugin log (`logs/plugins/<id>.log`) in the TypeScript format, but not yet the transport notes TypeScript also writes there (a malformed JSON line or a line over 1 MiB on stdout, and spawn, stdin and write errors). The door's own plugin calls run through the sealed owner call: no call's capability session is left on the shared owner, concurrent first calls send one hello and one `ready`, a call queued behind a stop or teardown never reaches the child, and a `failing` refusal carries the enable hint; that the owner keeps its `failing` mark when Core restarts is still to be recorded in ADR 0027 and does not gate default-on. Per the maintainer's decision, default-on waits until these rows are green.

**PR 7 gate, owner parity PR A (2026-11-13):** still **RED** for the other rows. Three rows are green:
- **Auto-issued paths and hosts.** Core no longer issues exact `net.http` hosts or exact `fs.read` paths from the manifest. It seals `owning` (flag-off `needsAuthority`) and `explicitWildcardGrant` into `call_authority`, and the owner refuses every scoped capability outside an owning call with TypeScript's `scoped capability requires an active owning call`. A per-resource refusal inside an owning call keeps the broker's text with the same `capability_denied` code (maintainer decision Q4).
- **Assistant secret alias.** Core answers `capability.secrets.resolve` itself on the call's bridge connection when the manifest declares it, and `capability.identity.sign` on every call, so an undeclared signing request is refused and audited as flag-off does. A flag-on assistant turn answers like flag-off, and a Core call for another plugin during the turn gets the flag-off refusal (maintainer decision Q1).
- **Owner refusal text** outside an owning call.

**PR 7 gate, owner parity PR I (2026-11-13):** one more row is green:
- **Detached stop and inspection (F1).** With the native owner, serve's supervision stops an orphaned direct-executor attempt (its `_run` runner gone) as flag-off: the task settles `stopped` with exit 143 and the executor is gone (`test/plugins-native-owner-detached-stop.test.ts`). Core keeps the one-use `detachedStop`, `detachedInspect` and `remoteStop` grants and answers `capability.process.stopRun`, `capability.process.inspectRun` and `capability.hosts.stopOwned` as Core methods of the issuing call, with the flag-off refusal texts (`test/plugins-native-owner-detached-grants.test.ts`, [ADR 0027](../decisions/0027-one-native-plugin-owner-per-home.md)). A failed stop reconciliation is now logged (`pacer: task <id> stop reconcile failed: …`). Still open: a flag-on remote stop reaches Core's broker, but its SSH legs need the host runner the owner does not serve; and a flag-on `task.stop` while the runner is alive depends on runners no longer inheriting `PACER_HOST_SOCKET` (I1).

Service-launched terminals (F2): session viewers, `openInTerminal` launchers and built-in terminals no longer inherit `PACER_HOST_SOCKET`, as executors already did; the door's Core child keeps it.

The capability relay conformance cases (`fs.read`, exact-path `fs.read`, `fs.write`, `fs.beginWrite`, `process.spawn`, `net.http`) now match the TypeScript host with zero listener hits. The `plugin.doctor` path the Rust door ran itself forwarded no Core method, so another plugin's `capability.secrets.resolve` was refused with the owner's `secret alias was not issued` (same code), `capability.identity.sign` was not answered, and an undeclared signing request was refused without an audit line. Owner parity PR H relays the doors' calls through Core's sealed owner call, which proves the owner's key (PR G), and closes this gap (gate row "Door doctor path" below).

**PR 7 gate, owner parity PR G (2026-11-14):** still **RED**. One row is green and one stays open:
- **Bridge callers are authenticated** (#918 items 1 and 2, green): only a Core holding its owner's per-start key reaches an owner. A same-user peer without it is refused on every bridge method, and Core sends nothing to an owner that cannot prove it (`crates/plugin-runtime/tests/bridge_caller_auth.rs`, `test/host-bridge-auth.test.ts`). This closes the Q1 risk that such a peer reaches the assistant's resolved key or a signature through a lane it started. The accepted residual, a same-user process that reads `run/host.key` or Core's initial environment, or replaces a socket path, is stated in [ADR 0027](../decisions/0027-one-native-plugin-owner-per-home.md).
- **Executor sandbox profiles** (#918 item 3, **RED**, open): the profiles must deny reads of `$PACER_HOME/run/` and of the per-user socket directory (ADR 0027 item 5), and `connect()` to their sockets, with a test; or the key must move where a sandboxed executor cannot reach it. Until then an executor whose sandbox allows reading the home can read `run/host.key` and drive the owner. #918 stays open for this row, and default-on waits for it.

**PR 7 gate, owner parity PR H (2026-11-14):** still **RED** for the other rows. Three rows are green:
- **Door doctor path.** The serve door relays its `plugin.doctor` and `plugin.ui.*` calls to Core with the private `relay` kind, as attached stdio connections already did, and a self-owned stdio connection does the same. Core seals each call to the owner on its socket and answers the plugin's `capability.secrets.resolve` and `capability.identity.sign` requests itself. Another plugin's secret alias gets the flag-off refusal, and an undeclared signing request is refused and audited as flag-off. The conformance and assistant-key tests no longer list known differences for the door.
- **Door deadlines.** The doors' calls keep each method's flag-off deadline instead of a flat 30 s. A doctor ping fails at 5 s with flag-off's `plugin_timeout` text when the hello or the ping takes 7 s, and a `ui.render` fails at 2 s when the render takes 4 s, over HTTP and stdio (`test/plugin-conformance-native-owner.test.ts`).
- **Logs of a failed sealed call.** A sealed owner call that fails or misses its deadline keeps its call-scoped `capability.log` lines in `logs/plugins/<id>.log`, as flag-off writes each line when it arrives. The owner returns them in `error.data.logs`. When Core's deadline or a revocation ends a call that was already sent, Core shuts its write side and waits up to 1 s for the owner's final reply instead of closing the connection. This covers Core's own owner calls, the serve door, self-owned and attached stdio connections (conformance row "a timed-out call keeps its capability.log lines").

Two new rows are red, each with an expected-fail test in the same file. This PR introduces the second one on the serve door and on a self-owned stdio connection:
- **Owner hello-timeout crash accounting.** When a child's hello misses the call's deadline, flag-off stops the child and records a crash (`restarts` 1, `plugin.list` error "owning plugin call ended" or "plugin.hello passed its … ms deadline", whichever deadline fires first). The owner keeps the child and records nothing.
- **Readiness after a failed first sealed call.** When Core's deadline ends the first call or the call fails, Core never receives the hello summary, so `plugin.list` shows `idle` where flag-off shows `ready`. This affects Core's owner calls and attached stdio connections. This PR extends it to the serve door and to a self-owned stdio connection, whose own sealed call reported the hello even when the call failed. The fix touches `bridge_listener.rs`, `host-bridge.ts` and `registry.ts` and follows owner parity PRs F and G.

**PR 7 gate, owner parity R1 (2026-11-14):** the hello deadline row is green. The owner gives `plugin.hello` 10 s, as the registry's `HELLO_DEADLINE_MS` does, still bounded by the call's own deadline. A hello that outlives the 10 s fails `plugin_timeout` with `plugin.hello passed its 10000 ms deadline`, as flag-off; when the call's deadline ends the wait first, the call fails with `plugin call passed its absolute deadline`, also as flag-off. Every owner path sends the hello from one place, the owner's sealed call: Core's own calls and, since owner parity H, the calls the serve and stdio doors (attached and self-owned) relay through Core. `plugin.doctor` through any door or Core matches flag-off: the ping's 5 s deadline also bounds the hello. Not changed here: flag-off counts a hello timeout as a crash (it stops the child, `restarts` goes up and the restart backoff applies), while the owner keeps the unready child and counts nothing; the owner's crash accounting covers only exits it did not ask for. `crates/plugin-runtime/tests/hello_deadline.rs`, `test/plugins-native-owner-hello-deadline.test.ts`.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `config.get` | Native (P2) | Pure keys/sources via `pacer_config::settings::get_settings`; Core supplies filtered terminal choices, machine guard/slots and planner candidates through `/_internal/config-host-parts` (serve) or `_internal.config-host.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns terminal detection, slot sampling and planner discovery. `PACER_FORWARD_OPS` remains the escape hatch. |
| `config.set` | Native (P2-E, selective) | All keys use `pacer_config::settings::set_setting` plus the P3-B publisher, with the per-process in-flight key guard. Planner refusals, planner with `integrations: "skip"`, an unchanged planner with `install`, backend refusals, backend `direct` and any backend value with `PACER_BACKEND` set are native. Residual forwarding: a changed planner with `integrations: "install"` (integration install and rollback, wave 10) and backend `orca` without `PACER_BACKEND` (Orca readiness probe, wave 3). The in-flight guard is per front-door process and does not span native and forwarded edits (the TypeScript core keeps its own `pendingEdits`); each side's file-changed check still prevents silent overwrites. If the planner changes between the forward decision and the native write, the native reply is TypeScript's `conflict` "Strategy changed during edit". HTTP bodies serde_json rejects (a BOM, unpaired surrogate escapes, invalid UTF-8, numbers past the f64 range) are forwarded unchanged through `forwards_undecodable_body`, as stdio already forwards such lines. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.account.add` | Native (P2-D) | `pacer-config::host` maps `hosts.<alias>.accounts.<account>.home` and returns the login command (`account_login_command`); native callers retain endpoint sync and `hosts` publication. No SSH or host-adapter I/O. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.add`, `host.set`, `host.remove`, `host.repo.map` | Native (P2-D) | `pacer-config::host` owns YAML identity/edits and refusal parity. Native callers retain the private TypeScript endpoint-plugin synchronization bridge (`finishNativeConfigEdit`), publish the `hosts` area, and record `host.set` pause activity in Rust. `host.set` composes its summary via the host-read bridge after sync. Plugin-owned SSH execution stays forwarded. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.suggest` | Native (P2-D) | `pacer-config::ssh_config` reads `~/.ssh` aliases (Includes, HostName, no shell execution) and filters configured host `ssh` targets from `load_strategy`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.list`, `host.get` | Native (P2-D) | `pacer-lifecycle::hosts::list` / `detail` compose summaries and detail rows once Core supplies reachability, check caches, jobs, runners, repos and tasks through `/_internal/host-read-parts` (serve) or `_internal.host-read.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns live task/job/reachability reads and read-model executors for `host.get`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.check`, `host.clean`, `host.repo.setup` | Native (M2, selective) | Rust (`pacer-config-ops::host_check_clean_setup_ops`) validates params with Zod issue text, loads the host config, and runs the check/setup/clean logic from `pacer-lifecycle::hosts` over injected snapshots. Two effects stay on Core through the host effects bridge (`/_internal/host-effects`, `_internal.host.effects`): `probe` runs the SSH probe via the plugin host, `clone`/`identity` execute remote git/identity via job orchestration, and `transfer` checks the work-transfer gate for clean. Inputs needing the probe or job orchestration selectively forward; `PACER_WORK_GRANT` callers forward. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.terminal` | Forwarded (P2-D) | Terminal open (`openInTerminal` / builtin registry) stays in TypeScript. Library: `pacer-lifecycle::hosts::terminal_ssh` owns SSH argv/title only; it does not open a session. |
| `runner.settings.get`, `runner.settings.save` | Native (P2-D) | Native callers use `pacer-config::executor_settings` under the shared `executor-settings` lock; saves publish the `runners` area via the P3-B publisher (matching TS `mutation(..., "runners", ...)`). No endpoint-plugin sync (unlike `runner.set` / `remove`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `repo.list` | Native (M2, selective) | `pacer-repos` owns the `listRepos` read: `state/repos.json` and `repo-paths.json`, keys of active and recent tasks from the task store, stale filtering, the once-a-minute prune (under the shared `repos` lock) and two-second bounded branch reads. The path-reachability cache (`exists`, canonical path, `unreachable`) is a per-process stale-while-revalidate cache with the same semantics as `src/core/path-probe.ts`: Rust probes the filesystem itself in the background, so a cold Rust process reports what the TypeScript service reports on its first read. Both files read the way `readJson` and the object spread read them (`pacer-js-json`: JavaScript `JSON.parse` of lossy UTF-8; unparsable, unreadable or missing files and directories read as `{}`; arrays and strings spread into index keys; integer-index keys enumerate first; an own `__proto__` key is an ordinary key). Alias values name registry keys through ToPropertyKey (`null` falls back to the root), `lastUsed` sorts by ToNumber and the prune writes `Infinity` as `null`. These selectively forward: entries that are not objects or lack a string `key` or absolute `path`; a `lastUsed` whose conversion throws, or that compares as NaN beside other values; string alias values that are not absolute paths (maintainer decision Q4) and aliases that name inherited `Object.prototype` properties or whose conversion throws; lone surrogates; nesting deeper than 128 (Q5); FIFOs and other special registry files. The native prune re-reads the registry under the `repos` lock; the TypeScript prune writes without it. Parity: `test/native-repo-registry-parity.test.ts` (section 1a corpus over stdio and HTTP, prune timing). No longer on the Core bridge. `PACER_FORWARD_OPS` remains the escape hatch. |
| `repo.add` | Native (M2, selective) | `pacer-repos` owns `addRepo` and `registerRepo`: the absolute-path and `rev-parse --show-toplevel` checks, git identity (`rev-parse --path-format=absolute --show-toplevel --git-common-dir`, `remote get-url origin`, `remote`, each bounded to two seconds), `repoKey` canonicalization through `pacer-config::host::repo_key`, the `canonicalAsync` path walk feeding the per-process path probe, and the registry write under the shared `repos` lock (`repos.json` entry stamped `lastUsed`, linked-checkout alias in `repo-paths.json`, `JSON.stringify` bytes). `repo.add` publishes nothing, as in TypeScript. Rewrites keep spread registries' index-key order, own `__proto__` keys and extra entry fields, and write `Infinity` as `null`. Registries that `repo.list` forwards also forward `repo.add`, as does a registry or alias path that is a directory (the TypeScript write error names a random temporary file). Residual: if another writer turns the registry into a forwarded shape while registration waits for the `repos` lock, native `repo.add` (and an absolute-path `project.strategy.*` registration) returns `conflict` with `repository registry changed during registration` and writes nothing, where TypeScript rewrites the file it reads; this mirrors `repo.remove`'s `repository registry changed during removal`. No longer on the Core bridge; the TypeScript `/_internal/repo-bridge` and `_internal.repo.bridge` endpoints are removed. `test/native-repo-add-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `repo.remove` | Native (M2, selective) | `pacer-repos::remove_repo` owns `removeRepo` under the shared `repos` lock: both files read as `readJson` does (JavaScript `JSON.parse` of lossy UTF-8; unparsable, unreadable or missing files read as `{}`), the registry spread (arrays and strings into index keys), aliases written back unspread (array holes as `null`), and `JSON.stringify` bytes (fractional and large numbers, index-key order, extra entry fields, `__proto__` own keys). Symlinked state directories and files are followed like `writeJsonAtomic`: a symlinked registry file is read through and replaced by a regular file. Params strip unknown keys and read `null` as `{}`. Forwarded: lone UTF-16 surrogates, nesting deeper than 129 levels (node depth > 128), a directory or other non-regular file at either path or an unusable state directory, `null` registry entries and a deletion from a string alias file (engine `TypeError`). Residuals: a registry that turns into a forwarded shape between routing and the locked re-read returns `conflict` "repository registry changed during removal" without writing (TypeScript has no such text); write failures return `internal` with Rust's OS error text, not Node's; an HTTP body `serde_json` rejects (lone-surrogate escape, BOM, invalid UTF-8, a number past f64) gets the native `400 invalid_input` "body is not JSON" reply, until #909 forwards such bodies for `repo.remove`. `test/native-repo-remove-parity.test.ts`, `crates/repos/tests/remove.rs`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `plugin.list`, `plugin.doctor`, `plugin.ui.list`, `plugin.settings.get` | Native (HTTP, stdio) | Rust owns read models and surface checks; grants come from the authoritative TS snapshot. Core supplies generation-bound authoritative process snapshots and read RPC over authenticated private IPC: `/_internal/plugins` on serve, `_internal.plugins` on stdio (sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`, hello v3 and no work grant). Forced-forward requests retain the TS reference. Reads fall back to TypeScript when a prepared snapshot or settings record exceeds 512 JSON nesting levels, or the aggregate prepare snapshot exceeds its budget; settings files stay intact. HTTP replays the original body; stdio replays the original line, whose JSON-RPC envelope counts as one of the 512 levels. Stdio decodes plugin requests with the JavaScript-compatible codec, so lone UTF-16 surrogates stay native. Flag-on (`PACER_NATIVE_PLUGIN_HOST=1`), `plugin.doctor` reports `pid: null` for owner-supervised children on both doors, because Core's snapshot does not know the owner's pids; an attached stdio connection's Core learns a shared child's state and restarts only from its own calls, so its `plugin.list` can show a running child as `idle` until then. The owner reports each crash of a child it did not stop to the owning door's Core, which keeps `restarts`, `error`, the backoff and `failing` as TypeScript does; an attached connection's Core is not told, so its `restarts` can differ from serve's ([ADR 0027](../decisions/0027-one-native-plugin-owner-per-home.md)). |
| `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.set` | Native (HTTP P4d-3…P4d-7, stdio M2 wave 3) | X3 `MutationOperations` over Core private IPC. Flag-off: `/_internal/plugins` prepare/`call`/`stop`/`changed`/`publish`/`log` with TS child spawn. Flag-on (`PACER_NATIVE_PLUGIN_HOST=1`): serve `ProcessOwner` starts/supervises children; Core supplies sealed `spawn_spec` + `call_authority` + hello bookkeeping (`ready`) and refuses local spawn when `PACER_HOST_SOCKET` is set; private `call` is retired on that path. **P4d-6/7** install a hello-sealed `PluginCapabilitySession` and bind Core-issued call-scoped `CallResources` so `capability.log` / `config.get` and fixture fs/process/http natives answer. **Default serve stays flag-off** until TypeScript plugin consumers (usage refresh, doctor, setup.health, planners) reach the owner over the bridge, with CT-11 on the Rust front door. Endpoint runner launches (`endpoint.launchEnv` with an empty credential-binding list; Core answers its config writes) and Orca executor attempts and live control (`orcaAttempt`/`orcaLive` sealed; Core answers every `capability.orca.*` effect) reach the owner; progress an Orca provider sends during an attempt fails the attempt flag-off and is dropped by the owner flag-on. Every other call with credential bindings (`endpoint.test`, keyed or keyless `endpoint.models` and `classifier.ask`), direct-executor progress and spawn admission, SSH host runners and file writes over one bridge frame are still refused there; `PACER_NATIVE_PLUGIN_HOST=0` is the documented escape for the future default-on flip (`serve_starts_reverse_bridge_by_default`). Bridge adds `_host.plugin.spawn` / `stop`. Stdio sends the same kinds over the sealed `_internal.plugins` method. Flag-on, each stdio connection attaches to the live serve owner (`run/host.sock`, same uid; plugin calls go through the sealed `relay` kind and disable/remove stops through `_host.plugin.stop`) or, without one, owns its children on its own `run/s<12-hex>.sock` until the connection ends or the door receives SIGTERM. When that path exceeds 103 bytes, the socket goes in a private per-user `pacer-<hash>/` directory (`DARWIN_USER_TEMP_DIR` on macOS, `$XDG_RUNTIME_DIR` on Linux, checked to be a real 0700 directory of the user); without one the connection refuses to start and names `PACER_NATIVE_PLUGIN_HOST=0` and a shorter `PACER_HOME`. Serve's `host.sock` stays in the home with the same 103-byte limit, so a deep home cannot run a flag-on serve. `PACER_HOST_SOCKET` decides per stdio connection; flag-off stdio removes an inherited one from its Core child ([ADR 0027](../decisions/0027-one-native-plugin-owner-per-home.md)). Crashes (PR 5): the owner learns of a dead child from its exit, and sends a child whose stdout closed SIGTERM, then SIGKILL after 2 s; it drops the lane and reports `{id, reason}` with the private `crashed` kind to the owning door's Core (`/_internal/plugins` on serve, `_internal.plugins` on an owning stdio connection; refused flag-off), which records it as its own exit and seals the next start (`spawn_spec.nextStartAt`) that the owner waits for. An owner-side restart floor per plugin with the same ramp and the same `failing` rule (three crashes within a minute hold the plugin until it is enabled again) covers doors whose Core is not told; a native `plugin.enable` through the owning door clears it. Known limits: an enable over an attached connection, or forwarded to TypeScript (`PACER_FORWARD_OPS`), clears only that Core's backoff, not the owner's floor (the next start waits out the floor within the call deadline, or stays refused while the owner marks the plugin failing); a crash reported while the owning door's Core restarts is dropped, not retried, so only the owner's floor counts it. A call in flight when its child dies fails `plugin_unavailable` with `<method>: plugin <id> exited on <signal>`, where TypeScript reports `<method>: plugin stdout closed` or `<method>: plugin exited on <signal>`, whichever it sees first. Serve shutdown and stdio teardown send SIGTERM at once and SIGKILL 2 s later, even with a call in flight: they reach the children through a lane roster outside the owner lock, and no plugin call holds the owner lock while it waits for its child. A second flag-on serve on another port, on a home whose `host.sock` is live, waits up to 5 s (`PACER_SERVE_OWNER_WAIT_MS`) and exits 3 (on the port the live owner still listens on, it fails to bind first and exits 1); `pacer doctor` reports the socket with the owner pid from `run/host.sock.pid`. `test/native-plugin-crash.test.ts`, `crates/plugin-runtime/tests/owner_crash.rs`. Nesting fallback replays only reads; mutation nesting failures do not replay, and deeply nested `plugin.ui.render` results are refused. `PACER_FORWARD_OPS` remains the op escape hatch. |
| `plugin.install` | Native (HTTP P4d-4, stdio) | Retired Orca install refusal registered on both service registries (X3 parity). |
| `strategy.list`, `strategy.show` | Native (P2-B) | `src/api/ops.ts` remains the reference and forward fallback via `PACER_FORWARD_OPS`; reads reuse `pacer-config` `list_strategy_reads` / `show_strategy`. |
| `strategy.use`, `strategy.save`, `strategy.remove` | Native (P2-C) | `src/api/ops.ts` remains the reference and forward fallback; native effects use `pacer-config` and the P3-B publisher. |
| `routing.set`, `runner.reorder`, `runner.remove` | Native (P2-C) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. Host YAML mutations share the same bridge. |
| `runner.set` | Native (P2-C, selective) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. A string `model` is checked natively by `pacer-models` (`src/models/available.ts` without subprocesses) after the unknown-runner, planner and rank refusals: connection accounts list their declared `pacer-<account>/<id>` models, a fresh, well-shaped OpenCode listing cache (`cache/available-models/<sha256(runner)>.json`, under 600 s old) is served for any runner, and runners with no listing accept the model. An unoffered model is refused with the UTF-16 closest-model `Available:` hint, and an unlisted one gets the `<model> could not be checked: <note>` warning after the routing warnings. Residual: an OpenCode runner whose cache is missing, stale or malformed, a cache with odd shapes TypeScript would throw on (non-object items, non-string ids or notes, lone surrogates, nesting past 512), a legacy strategy that TypeScript migrates first, or an unloadable strategy forward to TypeScript, which runs `opencode models`; the front door never spawns OpenCode. Invalid params fail natively with the same error. |
| `notifications.get`, `notifications.set` | Native (P2-C) | Native settings migration and writes; TypeScript remains the forward fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.prune`, `task.restore` | Native (P3-D) | Shared `TaskStore` retention helpers; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.dismiss` | Native (P3-D) | `pacer-lifecycle::dismiss_tasks` + P3-B activity/task publication; Core supplies `autoCleanTask` through `/_internal/task-auto-clean` / `_internal.task-auto-clean` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.diff` | Native (P3-D) | `pacer-lifecycle::task_diff` mirrors `src/tasks/diff.ts` git argv (`--literal-pathspecs`, merge-base, `-z` name-status/numstat, snapshot `diff.json` fallback, patch caps). Native serve/stdio runs git via `CommandGit`; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. Path-probe `markPathUnreachable` stays TypeScript-only until a git-read bridge is needed on macOS serve. |
| `task.list` | Native (P3) | Composed via `pacer_read_model::tasks::task_list_page` once Core supplies active sessions and runner liveness through `/_internal/session-probe-parts` (serve) or `_internal.session-probe.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns session lifecycle and `pidAlive`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.get` | Native (P3) | Composed via `pacer_read_model::task_detail` plus Core enrichment through `/_internal/task-read-parts` / `_internal.task-read.parts` (session probe, git diffstat/branch, tokens, retry options, dispatch `work` / `managedSkip`, agent-check acceptance gating, activity timeline tail). TypeScript still owns git, usage broker reads and session lifecycle. `PACER_FORWARD_OPS` remains the escape hatch. |
| `snapshot.get` | Native (P8) | Composed via `pacer_read_model::ReadModel::snapshot` once Core supplies setup, policy, machine guard samples, service row, desktop updates, pairing eligibility, session probe and live `computeStatus` through `/_internal/snapshot-probe-parts` / `_internal.snapshot-probe.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns setup probes, plugin policy, discovery pairing, status warming and session lifecycle. `PACER_FORWARD_OPS` remains the escape hatch. |
| `machine.get`, `machine.set`, `machine.rotate` | Native (P8) | Rust owns the identity store (`crates/server/src/native/machine_identity.rs`): load/create, clone detection, rename, crash-safe rotation and recovery, signature audit, the rotation activity line and `machine` entity event, and the `machine` config publication. It shares `identity/` files, Keychain items (via `security`), the install salt and the `identity` lock with `src/identity/`. No Core bridge. Cross-runtime coverage: `test/native-machine-parity.test.ts` and `cargo test -p pacer-server machine`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `files.search` | Native (P8) | `pacer-lifecycle::files_search` owns the whole operation with no Core bridge: zod-equivalent validation, the executor/work-grant refusal (`isExecutorSession` including Orca worktree names from the active strategy), the read-only registry listing with its own stale-while-revalidate path probe, bounded `git ls-files` / running-task `git diff --name-only` with the scrubbed git environment, 5 s listing caches, UTF-16 matching/ranking, and symlink-safe sizes. The path probe starts cold per process, so a missing repository reads as `error` until a probe has seen it, as on a fresh TypeScript core. When several running tasks change one path, `changedBy` follows task id order (TypeScript follows git completion order). `test/files-search-parity.test.ts` compares both runtimes byte for byte. `PACER_FORWARD_OPS` remains the escape hatch. |
| `setup.check` | Native (P9) | Rust validates empty params; service/link/status probes stay on Core through `/_internal/setup-check` / `_internal.setup.check` (stdio, sealed). Serve passes `snapshotProbe: false` like the HTTP op deps. `PACER_FORWARD_OPS` remains the escape hatch. M2 re-evaluation: converting it to Rust ownership needs cache-only `computeStatus` (in-process status cache and plugin readings), `policySummary` over plugin registry metadata and the service backend status, so it stays on the bridge. |
| `onboarding.skip` | Native (P9) | Writes `onboarding/skipped` and publishes the `setup` config area via `pacer_store`; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `doctor.run` | Native (M2, selective) | Registered on stdio and HTTP. Rust (`pacer-config-ops::doctor_ops`) validates params as the stripping `z.object({})` does (`null` reads as `{}`; non-objects get Zod issue text) and sends Core `{op, params: {}}` over the setup doctor bridge (`/_internal/setup-doctor`, `_internal.setup.doctor` sealed on stdio, `pacer-server::native::setup_doctor_sync`). Core runs the diagnostics there (`runDoctor`): the planner plugin's `planner.check`/`planner.plan` read the in-process plugin registry, the Claude handler probes run the TypeScript hook handlers (`probeClaudeHandlers`) and the status checks need `computeStatus` over live plugin usage readers, so no check has a pure native path. Forwarded while `PACER_WORK_GRANT` is set. `PACER_FORWARD_OPS` remains the escape hatch. |
| `version.get` | Native (P9) | Package and protocol metadata from `PACER_BUILD_VERSION` / workspace `package.json` and the frozen v3 protocol string. Login-service install/running status remains on `service.status`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `api.list`, `api.describe` | Native (P9) | Registry introspection from checked-in `op_catalog.json` (parity with TypeScript `opJsonSchemas()`). `api.list` filters match TS prefix/search semantics; `api.describe` returns captured JSON parameter schemas. `PACER_FORWARD_OPS` remains the escape hatch. |
| `delegation.pause`, `delegation.resume` | Native (P5) | `pacer-engine::pause` writes `state/pause.json`, publishes the `pause` event, appends activity, then publishes the `delegation` config area. No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `mode.release` | Native (P5) | Clears `state/mode-hold.json` via `pacer-engine::mode_hold` and publishes the `mode` config area. |
| `mode.hold` | Native (P5, M2 wave 4) | Explicit `until` is native. Without `until`, Rust (`pacer-config-ops::engine_ops::mode_hold`) reads the planner account's `resetsAt` from the usage-broker parts (`/_internal/status-broker-parts` / `_internal.status-broker.parts`), else holds for seven days, and writes the same `state/mode-hold.json` bytes; a past reset is refused with TypeScript's text. Params follow the Zod schema (issue order, `null` reads as `{}`). Integral `until` values are written without a fraction; one of 2^64 or more forwards, since `JSON.stringify` writes it in full (below 1e21) or as `1e+N`, which a serde_json number cannot. Otherwise forwards only when `until` is omitted and Rust cannot load the strategy as Bun would (`strategy_load::native_load`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `limits.report` | Native (P5) | Resolves the runner through `pacer-config`, marks `exhausted.json` + evidence via `pacer-engine::exhausted` (manual). No publish. |
| `limits.check` | Native (P5c) | Row projection via `pacer_engine::usage_broker::limits_check` once Core supplies `accounts` + `providers` through `/_internal/status-broker-parts` (serve) or `_internal.status-broker.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns `computeStatus` / plugin readings. `PACER_FORWARD_OPS` remains the escape hatch. |
| `limits.refresh` | Forwarded (P5b) | `refreshAccountUsage` / `refreshAllUsage` coordinator (`src/usage/refresh.ts`): per-account dedupe, 15-minute automatic throttle, outcome projection from prior/current readings. Effectful reads via `readAccountUsage(..., refresh: true)` and `readPluginUsage` (provider CLI, Ark CLI, passive Claude logs). Beyond P5c read-only status-broker injection; HTTP `usageRefreshDone` rebuilds cached status after manual refresh. Library: `pacer_engine::usage_refresh` mirrors capability/outcome rules only. `PACER_FORWARD_OPS` remains the escape hatch. M2 re-evaluation: not a pure read; every supported path calls plugin usage readers, the pending/automatic-throttle map is per TypeScript process and `usageRefreshDone` rebuilds the service's in-memory status cache. |
| `routing.status` | Native (P5d) | Composed via `pacer_engine::usage_broker::routing_status` with the same P5c `accounts` + `providers` bridge (`/_internal/status-broker-parts` / `_internal.status-broker.parts`). TypeScript still owns live `computeStatus`. `calendarPace` defaults in Rust until the bridge carries planner profile hints. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.route` | Native (P5d, selective) | Broker-backed `usage_broker::routing_route` / `status::rank_route` when params omit `goal` and `repo`. Params with `goal` (classifier) or `repo` (project policy + remote eligibility) selectively forward to TypeScript. A routed id without a configured runner is excluded as `not configured`, as in TypeScript `rankExecutors`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.get` | Native (P5b) | Pure strategy routing document read via `pacer-config::config_writes::get_routing` (rules + available executor ids). No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.request_review` | Native (P6) | Store-only handoff note via `pacer-lifecycle::request_review` + read-model `api_tasks` projection. No runner, plugin, messaging or supervision. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.delegate`, `task.retry`, `task.retry_all`, `task.answer` | Forwarded (P6e-run+) | P6b/P6e-run `run_spawn` pins and guards the `_run` plan; P6c found no native registration with parity (policy, prepared admission, work grants, messaging turns, effectful spawn). Do not register until spawn+admission parity lands. |
| `task.stop` | Native (P6, selective) | Rust `record_task_stop` owns store CAS + task outbox publication; Core supplies runner liveness, signal/host stop, live-worker release and settle activity through `/_internal/task-stop-probe` / `/_internal/task-stop-effects` (stdio `_internal.task-stop.probe` / `.effects`, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). Selectively forwards when the probe reports managed work or a live agent session / pending checks (same as TypeScript `stopWork` / agent-session gates). `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.ask` | Forwarded (P6d+) | P6d library only; public op still needs messaging and supervision beyond store fields. |
| `task.wait` | Native (P6, selective) | When `task_wait_settled` already holds (Core `taskWaitProbe`: terminal state without agent-session or pending-check holds), Rust returns the summarized task immediately via `summarize_api_task`. Active tasks forward for queue drain, runner supervision and agent waits (`/_internal/task-wait-probe`, stdio `_internal.task-wait.probe`, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.review` | Forwarded (P6d+) | P6c library: `record_review_verdict` owns accept/reject SQLite fields only. Public op still needs policy, agent-session gates, labels/activity, messaging `send_back`, retry/delegate/`_run`, and `autoCleanTask`. |
| `task.retry_options` | Forwarded (P5b/P6) | Needs routing/policy ranking over live readings (same broker gap as `routing.route`). |
| `session.create` | Forwarded (P7) | Idempotent conversation start needs attachment draft claim, `prepareDelegate` admission, work grants and `launchTaskRunner` spawn. Library: `params`, `operations` (reference/summary), `plain`, file/frame/control goldens only. |
| `session.resume` | Forwarded (P7) | Needs live session probe, executor resume capability, prepared admission consume, queue mutation and runner spawn. Native vt100 replay gate remains **NO-GO**; session WebSocket stays TypeScript. |
| `session.end` | Forwarded (P7) | Needs `taskStop` orchestration, runner supervision and conversation activity publication beyond store-only fields. |
| `session.context` | Native (P7 session reads) | `pacer-task-ops::session_context_ops` reads the conversation task from `state/tasks.db` and its private attachment draft through `pacer_store::attachments` (`ctxWithId`, `requireConversation`, `requireDraft`, `listAttachments`): Zod issue text, the enforcement-identity refusal, the `unknown task` and conversation gates, the 24-hour expiry of unclaimed drafts at request time, ready attachments in SQLite row order, and the attachment table creation TypeScript performs on first read. No Core bridge: nothing in the result is live session state. Work-grant callers are forwarded like every op. A truthy non-string `sessionDraftId` reports `not_found`. TypeScript stores only UUID strings, so this matches unless a hand-written draft id equals the number's text, and for an object or array TypeScript raises a SQLite binding error instead. Parity: `test/native-session-context-parity.test.ts` and `cargo test -p pacer-task-ops session_context`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `session.prepare` | Forwarded (P7) | Executor capability discovery, repo/workspace validation and plugin-backed preparation. |
| `session.draft.create` | Forwarded (P7) | Attachment store mutation with 24-hour expiry policy. |
| `session.file.read` | Forwarded (P7) | Secure workspace reader, attempt-scoped paths and revision conflicts; `file_reference` owns syntax only. |
| `session.attachment.prepare` | Forwarded (P7) | Running-session gate, attachment claim and agent-specific delivery preparation. |
| `session.agent.create` | Forwarded (P7) | Independent agent spawn inside an existing task workspace; needs plugin IPC, admission and native session identity. |
| `session.agent.list`, `session.agent.get` | Forwarded (P7) | Task-scoped agent session enumeration and attempt reads over live store and plugin state. |
| `session.agent.end`, `session.agent.retry`, `session.agent.resume` | Forwarded (P7) | Effectful agent-session lifecycle (stop, fresh attempt, resume) with `expect_rev` orchestration; no native registration while replay/WS gate is **NO-GO**. |
| `dispatch.config.get` | Forwarded (P5/P6) | Composes planner identity and effective dispatcher YAML (strategy override or built-in defaults) from `loadStrategy`; no native dispatch settings read yet. |
| `dispatch.enforcement`, `dispatch.enforcement.probe`, `dispatch.enforcement.consent`, `dispatch.enforcement.denied` | Forwarded (P5/P6) | Native subagent control certification: policy repo resolution, observation-backed diagnostics, quota-using probe jobs, consent ledger and strict-mode denial recording (`src/api/ops.ts`; unauthenticated POST for `denied` in `src/serve/http.ts`). Needs plugin jobs and executor-native control probes. |
| `dispatch.preview`, `dispatch.explain` | Forwarded (P5/P6) | Read-only ranking and ladder explanation over cached observations and the replaceable decision engine; needs live usage readings and `core.dispatch` / `explainDispatch` parity beyond P5d broker slices. |
| `dispatch.submit`, `dispatch.child` | Forwarded (P6) | Root and scoped child admission: work grants, queue mutation, delegation policy, prepared admission and `launchTaskRunner` spawn (`submitWork`, `delegateChild`). P6b `run_spawn` records plans only. |
| `dispatch.list`, `dispatch.tree`, `dispatch.events` | Forwarded (P6) | Work-store reads and timelines over managed roots (`listWork`, `scopedWorkTree`, `scopedWorkEvents`); no native work graph projection while session/task enrichment stays on TypeScript bridges. |
| `dispatch.wait` | Forwarded (P6) | Polls until a work item settles via `waitWork`; needs queue drain, runner supervision and the same orchestration gap as `task.wait` (P6d). |
| `dispatch.review`, `dispatch.retry`, `dispatch.answer`, `dispatch.stop` | Forwarded (P6) | Managed-work lifecycle at `expect_rev`: review acceptance, lineage retry, executor Q&A resume and subtree stop (`reviewWork`, `retryWork`, `answerWork`, `stopWork`); overlaps P6c/P6d task op gaps (messaging turns, spawn, `stopWork` tree). |
| `dispatch.dependencies`, `dispatch.dependencies.waive` | Forwarded (P6) | Same-root dependency graph edits with revision checks (`setWorkDependencies`, `waiveWorkDependency`); store effects plus work-tree projection responses. |
| `dispatch.models`, `dispatch.refresh` | Forwarded (P5/P6) | Model inventory and observation refresh with backoff (`listDispatchModels`, `refreshObservations`); issues scoped plugin/executor observation calls. |
| `dispatch.analytics`, `dispatch.learning.reset` | Forwarded (P5/P6) | Derived learning aggregates and per-repo reset/exclude (`dispatchAnalytics`, `resetLearning`); reads and mutates learning state beyond native routing broker. |
| `msg.send` | Forwarded (P6) | Turn delivery: participant policy, project messaging rules, held-message guardrails and admitted-executor resume via `sendMessage` / `deliver` (delegate, route, `spawnRunner`). |
| `msg.inbox`, `msg.log` | Native (P6, selective) | `pacer_store::messages` reads the `messages` table and work/task parent links in `tasks.db` (`store.inbox`, `store.thread`); Rust resolves the caller participant as `callerParticipant` does (executor env or own-worktree cwd, app cookie, planner env, bearer plus valid `X-Pacer-Session`, `external:local`) and applies the `assertCanRead` root check for `msg.log`. Work-grant and enforcement-token callers, and Orca worktree cwds outside an executor session, selectively forward to TypeScript (`authorizeWorkOperation`, Orca workspace probe). `PACER_FORWARD_OPS` remains the escape hatch. |
| `msg.read` | Native (P6, selective) | Same caller resolution and forwards as `msg.inbox`; Rust marks receipts read in one immediate transaction (`store.markRead`, millisecond `read_at`). `human` callers selectively forward because TypeScript publishes task and attention events for read receipts (`publishTaskMessages`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `msg.wait` | Forwarded (P6) | Blocks up to 3000 s polling the inbox and marks returned messages read; a native blocking loop would hold the stdio connection, and `human` consumption publishes task and attention events. |
| `msg.confirm` | Forwarded (P6) | Human-only release of policy-held messages then `deliver` with runner spawn. |
| `msg.close` | Forwarded (P6) | Sets `msgClosed`, parent/origin/human authorization and `autoCleanTask` worktree release; no review verdict. |
| `msg.policy` | Forwarded (P6) | Effective repository guardrails and hypothetical `checkSend` evaluation (`effectivePolicy`): needs the Zod-defaulted strategy messaging config merged with project messaging rules, plus relation, rate-limit and held-message evaluation that has no Rust owner yet. |
| `desktop.capture.register`, `desktop.capture.targets`, `desktop.capture.request`, `desktop.capture.claim`, `desktop.capture.complete`, `desktop.capture.result` | Forwarded (P8/P9) | Desktop capture broker over connected authenticated desktop clients (`src/desktop/capture-broker.ts`, `src/api/ops-desktop.ts`): worker credential renewal, owned-window inventory, request/claim/complete lifecycle and PNG metadata reads. Bounded image upload stays on authenticated HTTP routes. |
| `desktop.update.status`, `desktop.update.check`, `desktop.update.download`, `desktop.update.restart`, `desktop.update.cancel`, `desktop.update.configure`, `desktop.update.adopt`, `desktop.update.adoptCancel` | Forwarded (P8/P9) | Verified desktop OTA and service-adoption runtime (`src/api/ops-desktop-update.ts`, `src/desktop/update/`): feed checks, signed download, restart reservation, adoption handoff and public status. Snapshot probe carries update rows only; effectful install/restart stays TypeScript. |
| `desktop.reconcile.status`, `desktop.reconcile.request`, `desktop.reconcile.cancel` | Forwarded (P8/P9) | Service reconciliation assessment and (future) native-proof request/cancel stubs (`src/api/ops-desktop-reconciliation.ts`); `request`/`cancel` remain unavailable until reconciliation is implemented. |
| `discovery.list`, `discovery.network.get` | Forwarded (P8) | LAN discovery state reads: radio availability, found machines (cap 100), per-network advertising rows and revision counters (`src/api/ops-discovery.ts`, `src/discovery/`). |
| `discovery.set`, `discovery.respond`, `discovery.network.set` | Forwarded (P8) | Machine-local discovery mutations with `expect_rev`, config publication and attention re-derivation; `respond` pair may hand over to a pairing plugin (`src/discovery/handover.ts`). Executor sessions refuse set/respond/network.set via caller policy. |
| `assistant.status`, `assistant.candidates` | Forwarded (P7/P8) | Availability, selected endpoint account, planner pacing refusal, daily limits/usage and candidate endpoint accounts with fixed read-tool summary (`src/api/ops-assistant.ts`, `src/assistant/service.ts`). Executor sessions get `not_allowed` via caller policy. |
| `assistant.settings.get`, `assistant.settings.set` | Forwarded (P7/P8) | Assistant SQLite settings (runner/account, limits, retention) with revision-guarded writes and config-area effects (`src/assistant/store.ts`, `saveSettings`). |
| `assistant.conversations`, `assistant.conversation`, `assistant.turn`, `assistant.delete` | Forwarded (P7/P8) | Conversation history pagination and turn reads; deletes drop text while retaining usage aggregates (`src/assistant/store.ts`). |
| `assistant.ask`, `assistant.cancel` | Forwarded (P7/P8) | Turn lifecycle: redacted read-tool loop, bundled `pacer-assistant` plugin `respond`, checkpointing and SSE answer stream at `/v3/assistant/turns/<turnId>/stream` (`src/assistant/service.ts`, `src/api/http.ts`). Proposed actions stay client-confirmed; nothing executes from the turn itself. |
| `assistant.card.record`, `assistant.card.refresh` | Forwarded (P7/P8) | Action-card outcome recording and task-revision refresh for proposed ops the app runs separately (`src/assistant/actions.ts`, `buildCard`). |
| `account.list` | Forwarded (P7/P9) | Account inventory with usage/sign-in commands and no emails (`src/core/accounts.ts`). |
| `account.signin` | Forwarded (P7/P9) | Opens provider login in a terminal/tmux/Orca target or returns the command; interactive account-add/init flows share the handler (`src/api/ops.ts`, `accounts.signin`). |
| `account.add`, `account.edit`, `account.adopt`, `account.remove` | Forwarded (P7/P9) | Strategy `accounts` mutations: Claude/Codex homes, managed endpoints and OpenCode adoption with endpoint-plugin sync, protected-path home deletion and runner references (`src/endpoints/`, `src/core/accounts.ts`). |
| `account.models`, `account.test` | Forwarded (P7/P9) | Supplied-key or stored-key model discovery and isolated endpoint test tasks in a temporary git repo (`endpoints.listModels`, `testEndpoint`). |
| `account.usage.check` | Forwarded (P5/P9) | Quota-consuming usage observation jobs per account (Claude consent gate), plugin/CLI reads and warmed status via `usageRefreshDone` (`src/core/account-usage-check.ts`, `src/usage/`). |
| `terminal.list`, `terminal.create`, `terminal.rename`, `terminal.close` | Forwarded (P7) | Built-in workspace terminal tabs: idempotent shell spawn, revision-guarded rename/close and live state reads (`src/api/ops-terminal.ts`, `src/terminal/workspace.ts`). Refused for executor sessions. |
| `agent.detect` | Native (M2 service and agent, selective) | `pacer-install` owns the host half of `detectAgents`: the Zod `host` issue text, the enforcement refusal, the `AGENT_BINS` probe on the service `PATH` and the hour-long `cache/agent-detect-<sha256>.json` read keyed by `JSON.stringify([binaries, PATH, host])`; a fresh entry is answered natively. A miss, an expired or future entry, an entry without `rows`, or a relative process `PATH` entry selectively forwards, because interpreting the agent CLIs is the planner plugin's `planner.detect` capability (ARCH-12) in the TypeScript plugin host, which also writes the cache. Residual: if the entry disappears between the forward decision and the handler, the reply is `unavailable` with a retry hint. Parity: `test/native-agent-limits-parity.test.ts`. |
| `agent.preview` | Forwarded (P9) | Integration preview and undo command before consent. The preview is the planner plugin's `planner.preview` capability, which has no host fallback (ARCH-12), so it stays with the TypeScript plugin host. |
| `agent.undo` | Forwarded (P9) | Consent-gated restore of the files changed by the most recent connect, from its recorded snapshot and bound to that connect's preview revision, under the `setup` config area (`setup.agentUndo`). It shares the planner-plugin install transaction with `agent.connect`, so it stays in TypeScript until that path is native. |
| `agent.connect`, `agent.disconnect` | Forwarded (P9) | Consent-gated integration file writes and recorded undo disconnect under the `setup` config area (`setup.agentConnect`, `agentDisconnect`). The file plan and undo come from the planner plugin (`planner.preview` and install capabilities, ARCH-12) through the TypeScript plugin host and install transaction, so neither is native yet. |
| `service.status` | Native (M2 service and agent, selective) | `pacer-update` owns `serviceStatus` (`src/core/setup.ts`, `src/service/index.ts`): `installed` is whether the registration file (`~/Library/LaunchAgents/com.pacer.serve.plist` or `~/.config/systemd/user/pacer-serve.service`) reads; `launchctl print gui/<uid>/com.pacer.serve` or `systemctl --user show pacer-serve.service --property=...` is spawned from Rust as argv with a 2 s deadline (SEC-5), and `parseLaunchd`/`parseSystemd` semantics (JavaScript `\s`, `Number`, the `Object.fromEntries` quirk) produce `running` and `pid`. The health probe TypeScript runs does not change this reply. Other platforms (TypeScript refuses them) and macOS OTA fixture builds, whose sandbox label only the compiled fixture policy knows, selectively forward. Residuals: a timed-out manager is killed but not its process group, and its partial stdout is dropped (TypeScript keeps it); the OTA fixture forward is a path heuristic. On macOS hosts Linux parsing is covered by unit tests only. Parity: `test/native-service-update-parity.test.ts` (fake `launchctl`/`systemctl` on `PATH`). |
| `service.install` | Native (M2 service and agent, selective) | `pacer-install::install_ops` owns the `parseOpParams` refusals (`PACER_ROLE=executor` upgrade refusal, then the enforcement identity) and the `{consent: true}` schema. A valid request sends one `{kind: "install"}` effect over HTTP through the Core effects bridge (`/_internal/service-effects`), where Core runs the reference operation: the install transaction and manifest, the `pacerArgv` of the running core, `launchctl bootstrap`/`systemctl enable`, the deferred self-reload (`restarting: true`) and the health wait (`src/core/setup.ts`, `src/service/index.ts`). Work-grant callers and a pacer or Orca task worktree as the process directory (the executor check needs the strategy) selectively forward. The bridge call has no deadline, like the forwarded request: a slow install answers when Core finishes, and a caller that disconnects does not stop it. Over stdio the refusals are answered natively and an admitted request is forwarded unchanged to the Core child, because an inline bridge call would hold the stdio loop. Parity: `test/native-install-apply-parity.test.ts` (refusals and schema); end to end: `test/native-install-apply-e2e.test.ts` (both front doors and the bridge against a test core with recorded effects, compared with `PACER_FORWARD_OPS`; the install effect is never run against a real service manager. A test-ops front door shortens the other bridges' deadline with `PACER_TEST_BRIDGE_DEADLINE_MS`, and an install that outlasts it must still answer with Core's result while a `setup.check` control times out). |
| `service.handover`, `service.work` | Forwarded (P9) | Post-upgrade runner handover wait and running-task/session version inventory for reopen prompts (`src/setup/service.ts`, owner-only handover). `pacer-update::handover` has Rust validation and bridge plumbing, but neither op is registered: Core serves no `handover.effects` bridge yet. Making them native is tracked as a separate task. End to end: `test/native-install-apply-e2e.test.ts` (both front doors reply byte-identically to `PACER_FORWARD_OPS` forcing, including errors and caller identity, with no native trace). |
| `update.check` | Native (M2 service and agent, selective) | `pacer-update` owns the release feed check: enforcement refusal, `force` validation, the `update_check: false` opt-out, the cached feed read (`PACER_RELEASE_BASE`) and the cache write. A cached `latest` that is an array forwards, because only TypeScript reproduces its `String(array)` coercion. `PACER_FORWARD_OPS` remains the escape hatch. |
| `update.apply` | Native (M2 service and agent, selective) | `pacer-update::apply` owns the `parseOpParams` refusals (executor upgrade refusal, then the enforcement identity) and the empty schema. A valid request sends one `{kind: "apply"}` effect over HTTP through the Core effects bridge (`/_internal/update-effects`, no deadline), where Core runs the install-method preflight (package-manager and source installs are refused) and starts the shared `update.apply` job (download, verify, replace, refresh integrations, restart; `applyUpdate` in `src/api/ops.ts`). Work-grant callers and a task worktree as the process directory selectively forward. Over stdio the refusals are answered natively and an admitted request is forwarded unchanged to the Core child. Parity: `test/native-install-apply-parity.test.ts` (refusals, schema and the preflight refusal through the bridge); end to end: `test/native-install-apply-e2e.test.ts`, including a preflight held past the shortened test-ops bridge deadline that still answers with the job. |
| `task.attach`, `task.session`, `task.takeover`, `task.hand_back` | Forwarded (P6/P7) | Live session viewers, session-host metadata, headless-to-interactive takeover and hand-back (`src/api/ops-session.ts`, `src/tasks/session.ts`, `takeoverTask`, `handBackTask`). Shares the attach/viewer path with `session.*`; native vt100 replay gate remains **NO-GO**. |
| `task.send` | Native (M2, selective) | `pacer-task-ops::task_send_ops` owns `send` (`src/session/send.ts`) up to the live worker: the enforcement-identity refusal (`authorizeWorkOperation`, before the params are read), Zod params (code-point lengths, every issue in schema order), the executor refusal (`isExecutorSession` as `task.review`), `isTaskId`, the 1–4000 UTF-16 unit text check, then under the shared `task-{id}` lock that TypeScript's `withTaskLock` takes, the unknown task, `checkRev` (conflict with the projected task) and the waiting-question and not-running conflicts. The caller is `callerIdentity`: over HTTP the validated `X-Pacer-Client` and `X-Pacer-Client-Instance` headers, over stdio the CLI's `USER` and terminal session. Work-grant callers are forwarded, as for every operation. Core keeps what needs its backend plugins: a send that passes the record checks goes through the private bridge (`/_internal/task-send` over HTTP, `_internal.task-send` sealed by the stdio sync key), which applies `authorizeWorkOperation` again and runs the whole TypeScript `send` with the caller Rust named. That rechecks every refusal under the lock, decides the live worker and the 60-second driving lease there, claims the lease, delivers into the Orca worker or built-in PTY, gives the lease back on failure and records the timeline entry. The result is the TypeScript task record. MCP `task_send` stays in-process TypeScript. Residual: over stdio the bridge call runs in the request loop, as for `task.stop`. Parity: `test/native-task-send-parity.test.ts`, including enforcement identities with valid and invalid params and refusals decided while another process holds the task lock. `PACER_FORWARD_OPS` remains the escape hatch. |
| `runner.list`, `runner.block`, `runner.unblock` | Native (M2) | `pacer-config-ops::runner_ops` owns `blocked.json` (manual blocks, JS-stringified bytes through the private writer) and composes `runner.list` rows from blocks, `broken.json` and the provider eligibility the usage-broker bridge (`/_internal/status-broker-parts`, stdio `_internal.status-broker.parts`) supplies, as `listRunners` does (`src/core/runners.ts`, `src/executors/blocked.ts`, `src/exec/broken.ts`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `runner.add` | Native (M2, selective) | With `test: false`, `pacer-config-ops::runner_ops` owns `runnersConfig.add` (`src/core/runners-config.ts`): the non-interactive schema with Zod issue text, runner/account/host checks, the runner declaration, the routing rule insert (block or flow sequences, same YAML bytes) and the pacing rank, in one validated strategy edit; the `runners` config publication and the endpoint-plugin sync follow as for `runner.set`. Interactive terminals, check jobs (`test` omitted or `true`), params outside the schema and strategy files that are unreadable or not valid YAML (TypeScript reports its own parser's text) selectively forward. |
| `runner.check` | Native (M2, selective) | `pacer-config-ops::runner_check_ops` refuses natively with what `checkRunner` (`src/core/runner-check.ts`) refuses before `startJob`: the enforcement refusal, the `z.object({id})` issue text (length limits in code points, as Zod counts them) and `unknown runner <id>`. Starting the check job forwards for every configured runner, so no check runs natively: the check steps (CLI, sign-in, usage and the scratch test task) and the `runner-checks.json` result stay in the TypeScript job owner (`src/jobs/registry.ts`), and native `job.*` only read and cancel its job file. The schema strips unknown keys such as `test`, so `test: false` also forwards and starts the job. An unloadable strategy and `Object.prototype` ids forward too. Parity: `test/native-runner-check-parity.test.ts`. |
| `strategy.preview` | Native (M2, selective) | `pacer-config::strategy_write::preview_draft` applies the draft to the current `strategy.yaml` text without writing, then reports the Bun YAML bytes, schema problems and `summary`. `pacer-config-ops::strategy_preview_ops` ranks both strategies with `usage_broker::routing_status` over the usage-broker bridge rows that `routing.status` already uses. Those rows describe the current strategy, so a valid draft that changes provider inputs (`planner`, `accounts`, `hosts`, `runners`, `legacy`, `runnerAliases`, `providers`, or pacing thresholds and reserve) forwards to TypeScript, which recomputes `computeStatus` for the draft. A missing or schema-invalid current strategy answers natively with `invalid_input`, the `loadStrategy` message and the `strategyAction` hint. Other current strategies also forward: one whose load error carries Bun or Node text (a YAML syntax error, including an empty document, or an I/O error such as a directory, an unreadable or a non-UTF-8 file), and one whose `active` name `path.join` resolves to a different path (`.`, `..`, repeated separators, or an absolute name, which Rust's `Path::join` would read outside the home). One whose text Bun's YAML reader reads, or may read, differently forwards too: tabs, document markers after the first line, merge keys, `__proto__` keys, anchors, or block or tag indicators next to flow collections. The same text check applies to the draft's listed source strategy. Parity: `test/native-job-strategy-setup-parity.test.ts` and `test/native-project-strategy-parity.test.ts`, whose YAML corpus covers both sides of that check. |
| `strategy.build` | Native (M2) | Rust (`pacer-config-ops::strategy_build_ops`) validates params with Zod issue text, loads the planner and base strategy, owns the prompt template, `request_id` idempotency under the `strategy-build-<id>` lock, the intent and prompt files under `link/sessions` (atomic 0600 writes, seven-day cleanup) and the `strategy-build` alert. Two effects stay on Core through the setup effects bridge (`/_internal/setup-effects`, `_internal.setup.effects`): `status_text` renders `renderText(computeStatus)` from in-process status caches and plugin readings, and `strategy_terminal` opens the terminal (desktop work admission, `openInTerminal`, the app's built-in PTY for cookie callers). Core builds the agent argv (`strategyArgv`, including cursor-agent `--trust`) from the prompt file Rust wrote and validated IDs, never from a caller-supplied command. Forwarded while `PACER_WORK_GRANT` is set. `PACER_FORWARD_OPS` remains the escape hatch. |
| `client.register`, `client.heartbeat`, `client.list` | Forwarded (P6) | Client registry with 45-second lease renewal and connected instance listing (`src/api/client.ts`). |
| `client.control.enroll`, `client.control.targets`, `client.control.request`, `client.control.result` | Forwarded (P6/P8) | App-page control worker enrollment, allowlisted navigation/window/tray/quit requests and polled outcomes (`src/api/ops-client-control.ts`). |
| `client.control.claim`, `client.control.complete` | Forwarded (P6/P8) | Worker-side claim/complete loop for distributed UI actions; worker credentials stay page-private. |
| `project.messaging.get`, `project.messaging.set`, `project.messaging.remove` | Native (P6, selective) | `pacer-config::project_messaging` owns `project-messaging.json` reads, Zod-order normalization, revision checks and atomic writes under the shared `project-messaging` lock; set/remove publish the `project-messaging` config area via the P3-B publisher. Repository keys are native. Absolute checkout paths (Core repository probe), an unreadable or schema-invalid policy file (Node read errors and Zod issue text) and set params with invalid nested `rules` items or `liveness` selectively forward to TypeScript. `PACER_FORWARD_OPS` remains the escape hatch. |
| `project.strategy.list`, `project.strategy.get`, `project.strategy.set`, `project.strategy.remove` | Native (M2, selective) | `pacer-config-ops::project_strategy_ops` builds `repo` references from `pacer-repos` (read-only for policy keys and `list`, pruning for other keys as `resolveRepoInput` does), resolves executor aliases with `pacer_lifecycle::resolve_runner`, and owns `project-strategies.json` compare-and-set writes under the shared `project-strategies` lock in Zod schema order; set/remove publish the `project-strategies` config area. Absolute checkout paths resolve natively through `pacer-repos` (`resolveRepoInput` for get/remove, including `identityUnverified` references; strict `resolveRepo` for set) and register the checkout under the `repos` lock. A missing or schema-invalid strategy answers natively with the `loadStrategy` message as `internal`. Policy files are read the way `readFileSync(…, "utf8")` and `JSON.parse` read them, using `pacer-js-json`: invalid UTF-8 is replaced, and lone surrogates, out-of-range numbers, any depth and the last of duplicate keys are kept. Such values are therefore accepted where Zod never looks, in an own `__proto__` project (which Zod's record drops) or in an overwritten duplicate key. Elsewhere they fail the schema as in Zod. Unreadable, unparsable or schema-invalid policy files (including a directory, a BOM and invalid UTF-8 outside ignored values) answer natively with TypeScript's `Cannot read` or `Invalid project strategies` errors; `test/native-project-strategy-parity.test.ts` holds the validator-equivalence corpus. These forward selectively to TypeScript: registries that `repo.list` forwards; a strategy whose load error carries Bun or Node text (YAML syntax, including an empty document, or I/O); an `active` name that `path.join` resolves to a different path (`.`, `..`, repeated separators or an absolute name); strategy text Bun's YAML reader reads, or may read, differently (see `strategy.preview`); and a policy file that is neither a regular file nor a directory. `PACER_FORWARD_OPS` remains the escape hatch. |
| `job.list`, `job.get`, `job.cancel` | Native (M2, selective) | `pacer-task-ops::job_ops` reads `state/jobs/<id>.json` with the `pacer-lifecycle::jobs` helpers: id validation, `list` pruning of expired jobs and ICU-sorted output. `cancel` marks a running job `endedAt` and writes the file privately; the TypeScript job owner polls its file, so the write cancels across processes. Rust then publishes the redacted `job` entity event (`redactEndpointError` and email redaction). Job files whose shapes the TypeScript reader treats differently (non-object JSON, non-number `startedAt` or `endedAt`, unreadable directory) forward. Parity: `test/native-job-strategy-setup-parity.test.ts`. |
| `executor.setup.models` | Native (M2, selective) | `pacer-config-ops::executor_setup_ops` ranks cached catalog models from `cache/models.json` (fresh within 24 hours, strict `parseCatalog` shape): usable filter, coding, context and release ordering with ICU collation, and `classify` usage labels. The `local` group, `base_url` probes and providers without a usable cached catalog entry forward, because they need local model-server probes, the `opencode models` subprocess or a models.dev fetch. |
| `executor.setup.connect` | Native (M2) | Pure: Zod checks on `provider` and `key`, then the `opencode auth login <provider>` hand-off. It writes nothing. |
| `executor.models.available` | Native (M2, selective) | `pacer-config-ops::available_ops` with `pacer-models` (`src/models/available.ts`): a fresh 10-minute listing cache under `cache/available-models/` is echoed exactly as `JSON.parse` read it (odd shapes included), else connection models or native OpenCode discovery: `opencode models` runs with the environment and working directory the front door gives the Core child, minus the keys Core consumes at startup (`PACER_HOST_SOCKET_KEY`, `PACER_INTERNAL_NATIVE_BOOTSTRAP`, `PACER_INTERNAL_TOKEN`, `PACER_NATIVE_CONFIG_SYNC_KEY`) on both doors, where TypeScript passes on `PACER_INTERNAL_TOKEN` over stdio and `PACER_NATIVE_CONFIG_SYNC_KEY` over HTTP; a 90 s timeout or more than 64 MiB of stdout kills its process group and gives the "could not list" note, `<provider>/` lines get catalog facts from `cache/models.json`, and a non-empty listing is cached with a `wx` 0600 temp file and rename in a 0700 directory (never a failed or empty listing, never a connection list). `refresh: true` skips the cache; failures and empty listings return the TypeScript notes. Forwards an unloadable strategy, a runner id that is an inherited object key, a cache or reply serde cannot spell as `JSON.stringify` does (lone surrogates), a catalog entry the fact lookup throws on, and doors that recorded no Core working directory. If `cache/models.json` changes to an entry the lookup throws on between that check and the run, the reply is `unavailable` after the CLI ran (also on `runner.set` and `runner.models.*`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `runner.models.get` | Native (M2, selective) | `pacer-config-ops::runner_models_ops` reads the executor's default and allowed tiered models with the strategy-file sha256 revision, re-reading once to refuse a strategy that changed between reads (`src/core/runner-models.ts`). A missing, unparsable or schema-invalid strategy forwards. `PACER_FORWARD_OPS` remains the escape hatch. |
| `runner.models.set` | Native (M2, selective) | `pacer-config-ops::runner_models_ops` validates declarations with Zod issue text (`pacer-models::declarations`) and ids against the listing (`pacer-models::validate`), then edits under the shared `executor-settings` lock with the revision check, legacy migration through `ensure_migrated` and its backup, endpoint sync and `runners` publication. An OpenCode runner without a fresh listing cache is discovered natively before the lock, as `executor.models.available` does. Forwards before the lock when the strategy is unloadable, a legacy layout's migration bytes may differ, or the runner's listing has an unsupported cache or catalog or the door recorded no Core working directory. Residual: clearing a block `models` list followed by an indented comment writes valid YAML natively (the comment stays), where TypeScript refuses with `invalid_input` "All mapping items must start at the same column…" and writes nothing, because its `yaml` editor moves the next key's indentation. `PACER_FORWARD_OPS` remains the escape hatch. |
| `runner.models.set_many` | Native (M2, selective) | Validates every executor as `runner.models.set` does, then commits all defaults and tiered models in one revision-checked edit; any failure writes nothing. The whole request forwards before the lock when any listed runner would forward `runner.models.set`. Same residual as `runner.models.set` for a cleared block `models` list followed by an indented comment. `PACER_FORWARD_OPS` remains the escape hatch. |
| `dispatch.tierTargets.get` | Native (M2, selective) | `pacer-dispatch-ops::tier_targets_ops` reads the difficulty-to-tier mapping with the strategy-file sha256 revision, or the built-in defaults when the setup saves none (`src/core/tier-targets.ts`). An unloadable strategy forwards. `PACER_FORWARD_OPS` remains the escape hatch. |
| `dispatch.tierTargets.set` | Native (M2, selective) | Zod checks (enum issues, unrecognized keys, then the non-decreasing refine on `targets`), then a revision-checked edit of `dispatch.tierTargets` only under the shared `executor-settings` lock, with legacy migration, endpoint sync and `strategy` publication. An unloadable strategy forwards. `PACER_FORWARD_OPS` remains the escape hatch. |
| `executor.setup.candidates` | Native (M2, selective) | Rust (`pacer-config-ops::executor_candidates_ops`) reads the cached models.dev catalog, the OpenCode config providers and the strategy accounts, runs `opencode auth list --format json` (argv only, 15 s timeout, capped stdout) and builds the candidate groups, order and notes. Probing the two fixed local server URLs (Ollama, LM Studio) goes through the endpoint plugin on Core via the setup effects bridge (`discover`), because endpoint discovery is plugin-owned (P13). The bridge numbers failed probes in the order they settle, so distinct failure notes keep `detectCandidates`' order. Inputs stay forwarded when the catalog is missing, stale or malformed (TypeScript refreshes it over the network), when the strategy does not load, or while `PACER_WORK_GRANT` is set. |
| `attention.dismiss`, `attention.snooze` | Native (M2, selective) | `pacer-task-ops::attention_ops` raises items with `pacer_read_model::attention::raised` over the snapshot probe bridge (`snapshotProbeParts`, read-only status as in TypeScript `raisedItems`) and owns the `state/attention.json` transaction under the shared `attention` lock: Zod issue text, `unknown attention item` errors, unchanged-store no-op and JS-stringified bytes (`src/core/attention.ts`, `src/attention/store.ts`). Selectively forwards `discovery-network` items (raised from the radio network in TypeScript memory), dismissing task items (TypeScript also dismisses the task), an unloadable strategy, and store files or entries the TypeScript transaction would throw on. |
| `issue.import`, `issue.search` | Native (M2 issue reads, selective) | `pacer-issues` owns both ops: published and core Zod params (issue text and order, UTF-16 lengths), the enforcement-identity and executor refusals, registered-repository lookup through `pacer-repos`, the GitHub identity of the `origin` remote (`git remote get-url`, 5 s), issue references (`#n`, digit strings, same-repository URLs through WHATWG URL parsing), and `gh issue view` / `gh issue list` spawned from Rust as argv with the allowlisted environment plus `PWD`, lookup on the service `PATH`, a 20 s deadline over the exit and both output streams that kills the process group, a 4 MiB stdout cap, two running and eight waiting calls, and typed failures from exit codes and stderr. Untrusted titles, bodies and labels are cleaned to plain text as `src/core/issue-import.ts` does; search keeps only this repository's issue URLs, refuses `repo:`/`org:`/`user:` qualifiers and shares a 30 s cache of successes per process. Registries that `repo.list` forwards selectively forward to TypeScript. Residuals: `gh` output with lone-surrogate escapes is not JSON to serde (gh never writes them); the per-process path probe starts cold, so a missing checkout that a long-running TypeScript core has already pruned reads as `not_github` until a native probe has seen it; a `gh` that is found but cannot start reports the operating-system error text rather than Bun's. Parity: `test/native-issue-parity.test.ts` (fake `gh` on `PATH`). |
| `insights.summary` | Native (M2 analytics reads, selective) | `pacer-dispatch-ops::insights_ops` runs the `src/insights/summary.ts` queries over `tasks`, `task_first_settle`, `work_nodes` and `attempt_usage` for the period and the previous one: first-settle acceptance cohorts, per-agent spread (`parseRunnerId` agent), buckets, kinds, ladder steps and rules, and skip reasons. Sorts use ICU root collation (`localeCompare`), `byAgent` objects keep JavaScript integer-key order, `Math.round` rounds halves up, and parsing a routing `skipped` note stops where TypeScript throws. Params use Zod issue text and order, including the period refinements. Inputs with `from` or `to` at or above 1e15 forward, because only `JSON.stringify` prints those numbers. Residual: a skip reason cut at 200 UTF-16 units inside a surrogate pair keeps the lone surrogate only in TypeScript. Parity: `test/native-analytics-parity.test.ts`. |
| `onboarding.try` | Forwarded (P9) | Scratch-repo onboarding delegation via setup mutation (`setup.onboardingTry` in `src/setup/`). |
| `setup.init` | Native (M2, selective) | Rust (`pacer-config-ops::setup_init_ops`) validates the planner (Zod issue text, local planner IDs), sets the planner on an existing strategy without integrations (`pacer-config::settings::set_planner_without_integrations`) or detects installed CLIs, Ollama (`/api/tags`) and LM Studio (`lms ls --json`) and writes the starter strategy with the accounts migration, then publishes the `config` and `setup` changes. Forwarded when `OLLAMA_HOST` is `https://` with an installed `ollama` and no strategy file (TLS probe), or while `PACER_WORK_GRANT` is set. |
| `setup.health` | Native (M2, selective) | Startup Checking-setup gate: bounded doctor and setup checks as fixed steps, a persisted last-pass fingerprint and the snapshot probe; v3-only. Registered on stdio and HTTP. Rust (`pacer-config-ops::doctor_ops`) validates `trigger` against `startup`/`update`/`manual` with Zod issue text, strips other keys and sends Core `{op, params}` over the setup doctor bridge (see `doctor.run`). Serve adds `snapshotProbe: false` like the HTTP op deps; stdio leaves Core's default. Core runs the gate there because every run includes the full doctor step and the `setup.check` step, which stay on Core (see their rows), and writes the fingerprint from that report. Forwarded while `PACER_WORK_GRANT` is set. `PACER_FORWARD_OPS` remains the escape hatch. |
| `tree.status` | Native (M2 analytics reads, selective) | `pacer-messaging-ops::msg_ops::tree_status` resolves the caller as `msg.log` does (an executor may read only its own tree), walks `rootOf`, lists the work-graph node ids in `workTree` order (`depth`, `task_id`) and reads each task record, its pending messages and the tree's turn count from `state/tasks.db` (`pacer-store::messages`). Work-grant, enforcement and Orca-worktree callers forward through `msg_stays_forwarded`. Residual: a corrupt `work_nodes.options` or `work_decisions` row fails `workTree` in TypeScript but not natively. v3-only public op (`liveness.status` remains MCP-only). Parity: `test/native-analytics-parity.test.ts`. |

The fixed `bun run live native-config --id <id>` fixture compares all nine P2-C operations with `PACER_FORWARD_OPS=*` over stdio and HTTP. It requires a UI-seeded Rust test-ops sandbox, uses exclusive disposable homes, verifies native traces and persisted bytes, and reads config/strategy events through public SSE. All `/v2` operations and work-grant requests continue forwarding.

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C. Native `task.prune` / `task.restore` use the same `TaskStore` retention helpers as the TypeScript reference, including strategy `taskRetentionDays` (default 14) and the cross-runtime retention lock. Native `task.dismiss` persists `dismissed`, appends linked verdict activity, publishes a task outbox event, then runs the Core auto-clean bridge for the requested ids.

## P3-D task.diff (native + library)

`pacer-lifecycle::task_diff` owns progress-base/worktree selection, remote-running notes,
saved `diff.json` fallback, `-z` stat/name parsing and patch caps aligned with
`src/tasks/diff.ts`. The HTTP service and stdio proxy register native `task.diff`
and execute git with the same argv as the TypeScript reference (`CommandGit`).
Cross-runtime coverage: `test/task-diff-parity.test.ts`,
`test/fixtures/task-diff/file-tree-parity.json`, and
`cargo test -p pacer-lifecycle task_diff`.

## P6b `_run` spawn seam (library)

`pacer-lifecycle::run_spawn` matches `selfCommand`, `runnerLogPath` and the
`launchTaskRunner` env pins in `src/tasks/api.ts`. The module performs no
filesystem or process I/O; production spawn stays in TypeScript (`spawnRunnerProcess`).
Queue drain in Rust already accepts a launch callback returning `Option<u32>`; P6b
documents that the callback must honor `RunSpawnPlan` (`validate_run_spawn_plan`)
before a future native supervisor performs effectful spawn. Cross-runtime coverage:
`test/run-spawn-parity.test.ts` and `cargo test -p pacer-lifecycle run_spawn`.

## P6e-run `_run` launch guards (library, no new native ops)

P6e-run deepens P6b without registering `task.delegate` or activating
`RunSpawnOwner::NativeSupervisor`. `resolve_launch_admission_lease` and
`build_run_spawn_plan_for_launch` mirror `launchTaskRunner` lease inheritance;
`drain_launch_run_spawn_plan` and `guard_run_spawn_plan` are the required drain
hook checks before effectful spawn; `SupervisorRunSpawnSpec` maps a guarded plan
into ProcessOwner fields but returns an error while `RUN_SPAWN_OWNER` remains
TypeScript. Cross-runtime coverage: `test/run-spawn-launch-parity.test.ts` and
`cargo test -p pacer-lifecycle run_spawn`.

## P6c delegate lifecycle triage (library, no new native ops)

P6c evaluated `task.delegate`, `task.stop`, `task.answer`, `task.wait`,
`task.retry`/`task.retry_all`, and `task.review` for the largest safe native
registration. None met parity without the usage broker, plugin policy, messaging
turns, live-worker/supervision, or effectful `_run` spawn still owned by
TypeScript. The incremental library step is `pacer-lifecycle::record_review_verdict`
(store-only accept/reject fields aligned with `taskReview`) plus
`validate_run_spawn_plan` for drain launch hooks. Cross-runtime coverage:
`test/record-review-parity.test.ts` and `cargo test -p pacer-lifecycle record_review`.
Native registration for the forwarded ops remains a later slice (session probe,
spawn owner, policy bridge).

## P2-D host read triage (library + native suggest)

P2-D evaluated `host.list`, `host.get` and `host.suggest` for the largest safe
native registration. `host.suggest` met parity without SSH execution: Rust reads
`~/.ssh/config` (Includes and HostName, depth/cycle bounded) and subtracts
configured host `ssh` targets from strategy YAML. `host.list` and `host.get`
registered with the host-read private bridge: Rust composes
`pacer-lifecycle::hosts::list` / `detail` over Core-injected snapshots while
TypeScript still supplies live task/job/reachability/check reads and read-model
executors for detail. SSH-exec host ops remain forwarded. Cross-runtime coverage:
`test/ssh-config-parity.test.ts`, `test/host-read-parity.test.ts`, and
`cargo test -p pacer-config ssh_config`.

## P6d stop/wait triage (library + selective native stop)

P6d evaluated `task.stop` and `task.wait` for the largest safe native
registration. Full parity still needs agent-session gates, `stopWork` subtree
orchestration, queue drain and supervision for managed-work and agent-session
paths; those cases selectively forward to TypeScript. The safe native slice is
`pacer-lifecycle::record_task_stop` (store CAS) plus Core bridges for runner
liveness probe, process/host signals, live-worker release and settle activity
(pattern: `task.dismiss` auto-clean bridge). Selective native `task.wait` returns immediately when `task_wait_settled`
already holds (Core `taskWaitProbe` over agent-session holds); active tasks
forward for drain/supervise. Cross-runtime coverage:
`test/record-stop-parity.test.ts`, `test/native-task-stop-parity.test.ts`,
`test/native-task-wait-parity.test.ts`, `test/task-wait-settled-parity.test.ts`, and
`cargo test -p pacer-lifecycle record_stop wait_settled`.

## P7 session ops triage (library)

P7 evaluated all fourteen public `session.*` operations for native
registration. None met parity without attachment store effects, prepared
admission/work grants, runner spawn, live session WebSocket routes, offline
vt100 replay, plugin agent IPC or agent-session lifecycle still owned by
TypeScript. The incremental library steps are `pacer-sessions::params` (Zod-aligned
id/uuid/unicode-length/`expect_rev` bounds), existing `operations` reference and
summary helpers, `plain` stdout transcript streaming (#734), and file/frame/control
characterization goldens. Cross-runtime coverage: `test/session-params-parity.test.ts`,
`test/session-ops-parity.test.ts`, `test/session-replay-gate.test.ts`, and
`cargo test -p pacer-sessions`. Native registration for conversation and agent
session ops that need live sessions or replay waits on a full native vt100 replay **GO**, a session host owner, and
the P6 spawn/policy bridges. Session WebSocket and `/v3/.../session` routes remain
forwarded; do not register them, or session ops that depend on live sessions or
replay, while the replay gate is **NO-GO**. A later
slice registers `session.context` natively: it is a read model over the task
store and attachment drafts with no live session state (see its row). The other
thirteen stay Forwarded.

## P6f prepared delegate admission (library, no new native ops)

P6f evaluated `task.delegate` for native registration after P6b–P6d. Public
cutover still needs live plugin `policy.before`, work-grant and work-sync
validation, `commitDelegate` store/queue mutation, `launchTaskRunner` effectful
spawn and messaging turns owned by TypeScript. The incremental library step is
`pacer-lifecycle::delegate_admission`: `map_policy_amendment` and
`DelegateAdmissionSnapshot` mirror `prepareDelegate` / `prepareCreationAdmission`
host snapshot and amendment mapping; `prepare_delegate_admission` composes brief
parse, `validate_current`, runner resolution and `PreparedAdmission::prepare_delegate`
with injected policy. Cross-runtime coverage:
`test/prepared-admission-parity.test.ts`,
`test/fixtures/task-admission/prepared-admission-goldens.json`, and
`cargo test -p pacer-lifecycle prepared_admission`. Native registration waits on
host snapshot bridges (repo identity, exclusions, parent/work lineage), work-sync
grants and a NativeSupervisor `_run` owner.

## P6e dispatch and messaging triage (ledger, no new native ops)

P6e evaluated all twenty-three public `dispatch.*` and eight `msg.*`
operations for native registration. None met parity without the managed work
graph (`src/dispatch/work.ts`, `src/core/work.ts`), observation refresh and
learning stores, enforcement probe jobs, usage-broker-backed preview/explain,
effectful `_run` spawn, messaging store turns, project policy, and
`deliver`/`autoCleanTask` side effects still owned by TypeScript. This slice
only expands the ledger with explicit Forwarded rows and residual owners; it
does not register native handlers. Native cutover waits on P6 spawn ownership,
P5 observation/broker bridges, and a messaging read model. The messaging read
model has since landed for `msg.inbox`, `msg.log` and `msg.read` (see the Native
rows above); `msg.wait`, `msg.policy`, `msg.send`, `msg.confirm` and `msg.close`
stay Forwarded. v3-only `tree.status`
is named in the detailed Forwarded table above; `liveness.status` remains
MCP-only (`src/mcp/server.ts`).

## P7/P9 assistant, account, terminal, agent, service and update triage (ledger, no new native ops)

This slice evaluated all twelve public `assistant.*`, nine `account.*`, four
`terminal.*`, four `agent.*`, four `service.*`, and two `update.*` operations
for native registration. None met parity without the assistant plugin respond
path and read-tool whitelist, endpoint-plugin synchronization and key handling,
usage observation jobs, workspace terminal spawn/supervision, setup/service
install probes, agent integration file effects, or the shared update job pipeline
still owned by TypeScript. No operation is trivially pure read/write on static
config alone. This slice only expands the ledger with explicit Forwarded rows;
it does not register native handlers. Native cutover waits on plugin host
ownership, usage refresh bridges, and P9 setup/service owners. The later
assistant-reads slice registers ten `assistant.*` ops (see below);
`assistant.ask` and `assistant.cancel` stay Forwarded. The later M2 accounts
slice registers seven `account.*` ops (see below); a later slice registers
`account.list` and `account.signin` (see their rows).

## M2 accounts (native, selective)

`account.remove`, `account.add`, `account.edit`, `account.adopt`,
`account.models`, `account.test` and `account.usage.check` are registered
native on stdio and HTTP in the `pacer-account-ops` crate. Rust owns the logic
and the writes: the strategy edit, `endpoints/state.json`, evidence retirement
and home deletion. No op calls TypeScript to execute; the
`account_stays_forwarded` predicate forwards only the inputs listed in their
rows, and an enforcement identity is refused natively. After a native write the
existing endpoint-sync hook (`_internal.native-config.finish`) regenerates the
OpenCode endpoint configuration, and the `accounts` config area is published.
No handler reads, logs or returns an endpoint key. `account.list` later
became native over the account-list Core bridge, which carries the plugin usage
readings, endpoint rows, Orca labels and sign-in state, and `account.signin`
refuses natively while the terminal hand-off forwards (see their rows). `test/native-account-parity.test.ts` compares replies, errors,
strategy, endpoint state, evidence, OpenCode configuration and outbox events
against the TypeScript handlers.

## P7/P8 assistant settings and history cutover (native, selective)

`assistant.status`, `assistant.candidates`, `assistant.settings.get`,
`assistant.settings.set`, `assistant.conversations`, `assistant.conversation`,
`assistant.turn`, `assistant.delete`, `assistant.card.record` and
`assistant.card.refresh` are registered native on stdio and HTTP. Rust opens the
assistant tables in `state/tasks.db` with the TypeScript schema and pragmas
(`pacer-store::assistant`) and reads and writes them directly. No op calls back
into TypeScript to execute. Params use Zod issue text and order. The caller
policy from `parseOpParams` runs first: the enforcement token and executor
sessions (`PACER_ROLE=executor` or an own task worktree) get `not_allowed`, and
Orca task worktrees forward. Inputs where only TypeScript reproduces the result
also forward: admissible `status` (planner pacing), unreadable strategies, stored
settings that fail the schema, an unresolvable local time zone, and card refresh
for a task without a brief or title. `assistant.ask` and `assistant.cancel` stay
Forwarded: they need the assistant plugin, the read-tool loop, the SSE stream
and the in-process live-turn map. Parity: `test/native-assistant-parity.test.ts`
compares results, error bodies and the four assistant tables against TypeScript
`callOp`.

## P2/P6 client, project, runner, job and executor-setup triage (ledger, no new native ops)

This slice evaluated the remaining public `client.*`, `project.*`, `runner.*`,
`job.*` and `executor.setup.*` operations for native registration. None met
parity without client registry liveness, distributed UI control workers,
project messaging/strategy config effects, interactive runner add/check jobs,
shared job cancellation, or OpenCode endpoint onboarding still owned by
TypeScript. This slice only expands the ledger with explicit Forwarded rows; it
does not register native handlers. The M2 job, strategy and executor-setup slice
later registers `job.*`, `strategy.preview`, `executor.setup.models` and
`executor.setup.connect` (see below).

## M2 job, strategy preview and executor setup (native, selective)

`job.list`, `job.get`, `job.cancel`, `strategy.preview`, `executor.setup.models`
and `executor.setup.connect` are registered native on stdio and HTTP. Rust owns
the logic and the state: the job files, the draft application and validation,
and the cached model catalog. No op calls TypeScript to execute. The
`job_strategy_setup_stays_forwarded` predicate forwards only the inputs listed
in their rows. `strategy.preview` reuses the usage-broker bridge, like
`routing.status`, with its additive `draft` param for the current and draft
strategies' provider rows. The same route also takes `cacheOnly: true` for
cached, read-only rows (no op uses it yet); with no params its reply is
unchanged. The M2 setup slice
later registers `strategy.build` and `executor.setup.candidates` (see below).
`test/native-job-strategy-setup-parity.test.ts` compares replies,
errors, job files and outbox events against the TypeScript handlers.

## M2 setup init, strategy build and setup candidates (native)

`setup.init`, `strategy.build` and `executor.setup.candidates` are registered
native on stdio and HTTP. Rust owns validation, the strategy file writes,
the prompt and intent files, idempotency, subprocess probes and event
publication. The setup effects bridge (`pacer-config-ops::setup_effects`) carries only
three Core effects: rendering live status text, opening the strategy terminal
from the Rust-written prompt file, and endpoint-plugin discovery of the fixed
local server URLs. `setup_stays_forwarded` lists the forwarded inputs in each
row. `doctor.run`, `setup.health` and `setup.check` stay as their rows describe;
the M2 setup doctor slice below registers the first two.
`test/native-setup-parity.test.ts` compares stdio and HTTP replies, errors,
strategy files, session files, terminal hand-offs and outbox events against the
TypeScript handlers, with fake CLIs on `PATH`.

## M2 setup health and doctor (native, selective)

`setup.health` and `doctor.run` are registered native on stdio and HTTP. Rust
(`pacer-config-ops::doctor_ops`) owns parameter validation with Zod issue text and
sends Core the parsed params over the setup doctor bridge
(`/_internal/setup-doctor`, `_internal.setup.doctor`). Core produces both reports,
because the planner and plugin checks read its in-process plugin registry, the
Claude handler probes run the TypeScript hook handlers and the status checks
need `computeStatus`. `test/native-setup-doctor-parity.test.ts` compares invalid
param errors with the TypeScript handlers, checks the request Rust sends to
Core, runs that request through the Core bridge against `callOp` and checks
that the native reply passes the bridge report through unchanged.

## P6 project messaging cutover (native, selective)

`project.messaging.*` is registered native on stdio and HTTP. Rust validates the
operation params with Zod issue text and order, then reads and writes
`project-messaging.json` directly. Stored entries are rewritten in Zod schema key
order with integral numbers, as TypeScript `JSON.stringify` writes them. The
`project_messaging_stays_forwarded` predicate sends an input to TypeScript when
it names an absolute checkout path, when the policy file cannot be read or fails
the schema, or when `set` carries an invalid nested rule or liveness object.
`project.strategy.*` was later registered native on top of the Rust repository
registry (see its row and `test/native-repo-registry-parity.test.ts`).
`test/native-project-messaging-parity.test.ts` compares results, errors, file
bytes and outbox events against the TypeScript handlers.

## P5/P8 insights, issue and setup residual triage (ledger, no new native ops)

This slice evaluated `insights.summary`, `issue.import`, `issue.search`,
`onboarding.try` and `setup.init` for native registration. None met parity
without task-store analytics, user `gh` subprocess reads, onboarding delegation
spawn, or setup strategy initialization still owned by TypeScript. Native
`setup.check` and `onboarding.skip` remain the only P9 setup/onboarding native
ops. This slice only expands the ledger; it does not register native handlers.
The M2 analytics-reads slice later registers `insights.summary`, and the M2
issue-reads slice registers `issue.import` and `issue.search` (see their rows).

## P5b usage refresh triage (library, no new native ops)

P5b evaluated `limits.refresh` for native registration after P5c registered
`limits.check` on read-only status-broker injection. Refresh cannot reuse that
bridge: the coordinator calls `readAccountUsage(..., refresh: true)`, which
issues provider CLI commands, Ark CLI reads, or passive Claude log ingestion
through `readPluginUsage` (`src/usage/index.ts`, `src/plugins/usage-broker.ts`).
Selective native registration (compare `mode.hold` without `until`) does not
apply because every supported account path needs effectful plugin or subprocess
I/O, evidence reconciliation and cache mutation beyond injected broker rows.
The incremental library step is `pacer_engine::usage_refresh` (`refresh_capability`,
`refresh_outcome`, `automatic_refresh_suppressed`) aligned with
`src/usage/adapter.ts` and `src/usage/refresh.ts`. Cross-runtime coverage:
`test/usage-refresh-parity.test.ts` and `cargo test -p pacer-engine usage_refresh`.
Native registration waits on a refresh bridge that can run plugin reads and
publish warmed status (same gap as `account.usage.check` and live
`computeStatus` warming). The M2 service-and-agent slice registers the
`unsupported` path natively, which needs no read, and forwards every account
with a refresh source.

## P8 desktop and discovery triage (ledger, no new native ops)

P8 evaluated all seventeen public `desktop.*` and five `discovery.*`
operations for native registration. None met parity without the desktop capture
broker, verified OTA/adoption runtime, LAN discovery radio/state files, pairing
hand-over plugins, client registry liveness, and config/attention publication
still owned by TypeScript (`src/desktop/`, `src/discovery/`, `src/api/ops-desktop*.ts`,
`src/api/ops-discovery.ts`). Snapshot and read-model probes may carry desktop
update rows and pairing eligibility summaries only. This slice expands the
ledger with explicit Forwarded rows; it does not register native handlers.

## P8 desktop reconcile and discovery writes (native, selective)

A later slice re-evaluated `account.*`, `desktop.*` and `discovery.*` for
operations Rust can own from files alone. `desktop.reconcile.status`,
`desktop.reconcile.request` and `desktop.reconcile.cancel` are native: status is
the fixed peer-less assessment and request/cancel validate, then return
`unavailable`. `discovery.set` and `discovery.respond` are native over
`discovery/state.json` under the shared `discovery` lock and publish the
`discovery` config area. The `discovery_stays_forwarded` predicate sends
`respond` `pair` and any state file Rust cannot rewrite byte-for-byte to
TypeScript; `desktop_reconcile_stays_forwarded` sends request/cancel from an
Orca task worktree to TypeScript. `discovery.list`, `discovery.network.get` and
`discovery.network.set` later became native over the Rust `currentNetwork`
probe (see the detailed table);
`desktop.update.status` and `desktop.capture.targets` read in-memory service
runtimes; `account.list` later became native over a bridge for its usage,
endpoint and Orca plugin reads (see its row).
`test/native-discovery-desktop-parity.test.ts` compares results, errors, state
file bytes and outbox events against the TypeScript handlers.

PR #585 adds the native `/v3/tasks/<id>/log?follow=1` SSE route. It retains a read-only SQLite connection, detects database replacement, and drains bounded output chunks before `done`. When a read needs a legacy JSON import, an older schema migration, or malformed-record semantics, it calls the existing TypeScript `task.log` fallback with the current byte offsets. That core read performs the shared durable import; no per-stream import cache or new Rust state writer is used. The same fallback applies after a stream connects. All other `/v2` routes remain forwarded.

**P8 (HTTP events):** native `/v2/events` and `/v3/events` SSE replay the shared link outbox through `pacer-read-model::events::SseCursor` (cursor validation, retention `reset`, v2/v3 conversion, task enrichment, 15 s keepalive). Stdio `subscribe` stays TypeScript. `PACER_FORWARD_OPS=http.events` or `*` forwards the route to the core reference. No second publisher.

**P8 (snapshot.get):** native stdio `snapshot.get` composes the v3 snapshot through `pacer-read-model::ReadModel::snapshot` with the snapshot-probe bridge (session revision/active, runner liveness, deferred setup checklist, policy summary, machine guard samples, service metadata, desktop update rows, pairing eligibility and status or warming failure). Cross-runtime coverage: `test/native-snapshot-get-parity.test.ts` and `cargo test -p pacer-server snapshot_get`.

Like the TypeScript reference, follow mode resets the stderr byte offset to zero
when a task has no run record. If a later poll sees a restored run, its stderr
starts at byte zero. A missing stderr file on an existing run retains the offset.
The connected v3/v2 regression observes the missing-run poll before restoring it.
The independent TaskStore importer matrix uses separate Rust and TypeScript homes
and compares accepted/rejected records and the Rust database contents for every
numeric validation field (`rev`, `createdAt`, attempt `startedAt` and `endedAt`).

P4c registered four HTTP reads through
`pacer_plugin_ops::public::PublicRegistry`: `plugin.list`, `plugin.doctor`,
`plugin.ui.list` and `plugin.settings.get`. **P4d-3** adds the X3 mutation set
on the HTTP service registry (not on `PublicRegistry`): enable/disable/remove,
settings.set, ui.render/action/visibility. There is no public
`plugin.get`, archive inspection or publisher-trust read operation to register.
Handlers require an authoritative process runtime; without it, every plugin
operation forwards. The HTTP service supplies its supervised Core's single
process owner through the generation-authenticated `/_internal/plugins` channel.
The public listener rejects that channel. Rust owns the mutation/UI document
cache; Core still owns child processes. `PACER_FORWARD_OPS` can
force each native plugin op back to TypeScript. Stdio keeps all plugin operations in
TypeScript; no second plugin process owner is created. Native JSON envelopes are
bounded before recursive value handling. HTTP bodies, pre-effect private prepare responses or
settings records beyond 512 levels forward **reads** to TS; settings
files are left intact. Mutation nesting failures do not replay. Oversized aggregate prepare snapshots also forward reads before
any diagnostic call; successful diagnostic payloads are discarded because TS
ignores them. No operation is replayed after a diagnostic RPC. The bound is not a public JSON/schema rejection.

## P4d path scaffolding (X1 / X1b / X1c / P4d-1 … P4d-6)

`pacer-plugin-runtime` names the process-owner gate and the private
`PACER_HOST_SOCKET` / `$PACER_HOME/run/host.sock` contract. X1b lets a native
test-token `ProcessOwner` spawn/track live `PluginProcess` children and mirror
`Registry` shadow states in library form. X1c adds a dark Unix reverse-bridge
accept loop (0700/0600, peer-uid auth, stub `_host.plugin.call` /
`_host.plugin.find`). **P4d-1** wires serve so an explicit flag
(`PACER_NATIVE_PLUGIN_HOST=1` and/or `PACER_HOST_BRIDGE=1`) claims a native
`ProcessOwner`, starts the reverse bridge, and sets `PACER_HOST_SOCKET` on the
Core child; shutdown unlinks the socket. **P4d-2** attaches that owner to the
bridge so flag-on `_host.plugin.call` / `find` hit live children; unbound /
flag-off bridges keep stubs. **P4d-3** registers X3 mutation ops as Native HTTP
through an expanded `/_internal/plugins`. **P4d-4** moves flag-on child spawn
onto that ProcessOwner (native HTTP call/stop + bridge `spawn`/`stop`),
registers `plugin.install` refuse on HTTP, and has Core refuse local spawn when
`PACER_HOST_SOCKET` is set so one plugin id cannot have two live owners.
**P4d-5** lands the `PACER_NATIVE_PLUGIN_HOST=0` escape semantics and retires
private `call` on the flag-on path, but **keeps default serve TypeScript-owned**
(`serve_starts_reverse_bridge_by_default = false`). **P4d-6/7** wire
`PluginCapabilitySession` on the flag-on `ProcessOwner`: hello-sealed
`capability.log` / `capability.config.get`, plus Core `call_authority` that
seals the host-supplied reads/commands/http so native modules attach for
fixture plugin calls. Since owner parity PR A, `call_authority` issues nothing
from the manifest and seals `owning` (flag-off `needsAuthority`), so the owner
refuses every scoped capability outside an owning call as TypeScript does.
Default stays off because TypeScript plugin consumers cannot reach the native
owner: Core refuses local spawn when the host is on, and only native HTTP
`plugin.*` operations start children. P4d-13 flipped the const without that and
was reverted. Stdio native plugin ops and further `/_internal/plugins` deletion
remain later. See inventories under `.work/reviews/`.

### Per-scope plugin process owner (P4d-1 … P4d-7)

| Scope | Owner today | Notes |
| --- | --- | --- |
| Service (`pacer serve`) | TypeScript Core (default); Rust `ProcessOwner` when flag on | Flag-on: ProcessOwner starts/supervises children for native HTTP plugin RPC and bridge spawn/call/find/stop; answers hello-sealed `capability.log`/`config.get` and Core-sealed call-scoped fs/process/http (P4d-6/7); Core seals spawn_spec/`call_authority` and refuses local spawn; private `call` retired. Default stays off; `=0` escape ready for default-on. |
| Stdio (`pacer-core api --stdio`) | TypeScript | Unchanged (P8) |
| CLI one-shots | TypeScript | Unchanged |
| `_run` runners | TypeScript (effectful) | P6b/P6e-run: Rust `run_spawn` records and guards the launch plan with `RunSpawnOwner::TypeScriptCore`; drain hooks must call `drain_launch_run_spawn_plan` before injected spawners. ProcessOwner spawn via `SupervisorRunSpawnSpec` stays gated until `RUN_SPAWN_OWNER` cutover. Flag-on, a runner gets no `PACER_HOST_SOCKET` (`runnerProcess`, `build_run_spawn_plan`) and owns its plugin children as flag-off, so its attempt survives the end of the stdio connection or a service restart (I1, ADR 0027). |

## X3 / P4d-3 / P4d-4 / P4d-5 mutation status and remaining deferred work

- **P4d-3 Native HTTP (via Core IPC):** `plugin.enable` / `disable` / `remove`,
  `plugin.settings.set`, `plugin.ui.render` / `action` / `visibility`. Library
  fixtures remain: `plugin-strategy-byte-parity.json`,
  `plugin-public-parity.json`, `plugin-operation-number-parity.json`.
- **P4d-4 Native HTTP:** `plugin.install` (retired refuse). Flag-on ProcessOwner
  child spawn for native plugin RPC + bridge `spawn`/`stop`.
- **P4d-5:** `PACER_NATIVE_PLUGIN_HOST=0` escape parsing; private `call` retired
  when `PACER_HOST_SOCKET` is set; default remains off. Flag-on surface is
  prepare/spawn_spec/ready/stop/changed/publish/log (+ `call_authority` in P4d-7).
- **P4d-6:** hello-sealed `PluginCapabilitySession` on flag-on ProcessOwner;
  `capability.log` / `capability.config.get`; native fs/process/http modules
  reusable with issued `CallResources` (library proof).
- **P4d-7:** Core→Rust `call_authority` seals call-scoped `CallResources`;
  ProcessOwner binds natives for the call (fixture fs/process/http). Default
  remains off (executor-class resources + observation/hosts/orca + CT-11).
- **P4d-8:** Core `call_authority` seals observation bootstrap for
  `diagnostic.ping` / `policy.before` when `tasks.read` / `events.subscribe` are
  granted; ProcessOwner routes `capability.tasks.*` / `capability.events.subscribe`
  through `ObservationGeneration` (list proof; Core task projection bridge still
  open). Host `HostOperationResource` sealing validates exact issued ops.
- **P4d-9:** Core `call_authority` seals `hostSnapshots` when `hosts` resources
  are issued; flag-on ProcessOwner binds `with_hosts` + `NativeHosts` (library
  PROBE proof; live `hostRunner` bridge via ProcessOwner when snapshots present).
  Orca/worktree/executor-class resources and CT-11 remain open; default stays off.
- **P4d-10:** Core `call_authority` seals `orcaAttempt` / `orcaLive` and `orcaContext`
  when Orca resources are issued; flag-on `ProcessOwner` binds `NativeOrca` (library
  prepare proof; live `orca_bridge` private IPC when Core stashes an attempt bridge).
  Full executor.run on the native owner and CT-11 remain open; default stays off.
- **P4d-11:** Core `call_authority` seals `worktree` resources and `worktreeContext`
  when worktree is issued; flag-on `ProcessOwner` issues `NativeWorktree` (library
  `resolveBase` proof). `executorClaim` / process.run on the native owner and CT-11
  remained open; default stayed off.
- **P4d-12:** Core `call_authority` seals `executorClaim` and `executorContext`
  when a host-issued run claim is present; flag-on `ProcessOwner` binds `NativeRun`
  (library `claimRun` proof). Live Core `executor.run` stashing, full process.run
  lifecycle on the native owner, and CT-11 remain open; default stays off.
- **P4d-13 (reverted):** flipped `serve_starts_reverse_bridge_by_default = true`
  without CT-11. With the native host on, Core refuses local spawn but only native
  HTTP `plugin.*` operations start children through the `ProcessOwner`, so every
  TypeScript plugin consumer (usage refresh, doctor and setup-health integration and
  Usage checks, planners) failed with `plugin_unavailable`. The default is off
  again until TypeScript consumers reach the native owner over the bridge.
- **P4d-1 landed (flag-gated):** serve can claim `ProcessOwner` + reverse bridge
  + `PACER_HOST_SOCKET`. Default remains TS child ownership.
- **P4d-2 landed (flag-gated):** live `_host.plugin.call` / `find` against
  serve-owned children.
- **Blocked on later P4d:** flipping `serve_starts_reverse_bridge_by_default`
  (needs TypeScript plugin consumers to reach the owner over the bridge),
  deleting remaining `/_internal/plugins` kinds (still needed for
  prepare/spawn_spec/call_authority/ready/changed/publish/log), stdio native
  plugin ops, executor-class call resources, observation/hosts/orca on the
  native owner, and CT-11 live evidence.
- **Still deferred:** Rust signed archive inspection/extraction and publisher
  trust (crypto dependency tree). TypeScript archive/publisher remain.

## Config library boundary

`config.set` is registered native for all 19 keys: the 17 pure keys plus
`planner` and `execution.backend` where no integration install or Orca probe is
needed. The TypeScript handler remains the reference and the
`PACER_FORWARD_OPS` / selective-forward fallback. Like TypeScript
`pendingEdits`, a second edit of the same `<strategy path>:<key>` while one is in
flight is refused with `conflict` "This setting is already being changed".
`config.get` is native: `get_settings` owns the pure key/source map; host fields
arrive through the config-host private bridge (same sealing model as session-probe).
Library helpers (`compose_host_fields` / `host_fields_from_parts`) remain for
tests and callers that inject samples directly. Files are replaced through the
existing private atomic strategy writer (0600 files, 0700 directories); native
pure-key writes publish exactly one config change after success.

The complete pure setter allow-list is `execution.auto_clean`,
`task_retention_days`, `execution.local_max_tasks`,
`execution.local_memory_pressure_limit`, `execution.local_load_limit`,
`execution.launch_mode`, `pacing.order`, `pacing.policy`,
`pacing.planner_reserve`, `pacing.planner_reserve_headroom`,
`pacing.planner_probe`, `pacing.accounts`, `pacing.fill_threshold`,
`pacing.balance`, `update_check`, `terminal.app` and `terminal.open`. The read
model includes all 19 keys.

| Retained dependency | Forwarding boundary |
| --- | --- |
| Planner install/uninstall and rollback | Only a changed planner with `integrations: "install"` forwards to TypeScript `config.set` (wave 10). Refusals, `skip` writes (`set_planner_without_integrations`) and an unchanged planner with `install` (no write, `config` event) are native; the Rust setter refuses a changed install if reached directly. |
| Backend readiness and override hints | Only `orca` without `PACER_BACKEND` forwards, for the Orca readiness warning (wave 3). Refusals, `direct`, and any value with `PACER_BACKEND` set (with its override hint) are native. Rust reads reproduce `PACER_BACKEND` precedence. |
| Terminal availability | TypeScript filters detected terminal choices; native `config.get` reads the filtered list from the config-host bridge. Rust `filter_terminal_choices` / catalogue helpers accept the detected set without probing for library/tests. |
| Machine guard and current task slots | TypeScript samples pressure/load and slot use; native `config.get` reads the composed `machine` row from the bridge. Rust `machine_host_fields` accepts injected signals + `used` (no sysctl) for library/tests. |
| Planner candidates | TypeScript discovers compatible planner accounts; native `config.get` reads the list from the bridge. Rust accepts the candidate list as a host field for library/tests. |
| App/link `terminal.open` presets | Cookie-authenticated HTTP sets `PACER_TERMINAL_PRESETS_ONLY=1` on the request context so native pure-key writes match TypeScript `terminalPresetsOnly`. |
| `host.account.add` | Native YAML map + login command; no SSH or host-adapter probes. |
| Host YAML edits (`host.add` / `set` / `remove` / `repo.map`) | Native: `pacer-config::host` plus P2-C endpoint sync, `hosts` publication and pause activity (`host.set` summary via host-read bridge). |
| `runner.settings.*` | Native: library CAS + `executor-settings` lock + `runners` publication. Endpoint sync is not required for these ops. |
| `repo.list` | Native: `pacer-repos` registry read with JavaScript spread, key order and conversions, path probe, locked prune and branch reads; non-object entries, throwing or NaN conversions, non-path string aliases, lone surrogates, deep nesting and special files forward. |
| `repo.add` | Native: `pacer-repos` git identity and registration under the `repos` lock with `JSON.stringify` bytes; registries `repo.list` forwards and directory registry paths forward. |
| `repo.remove` | Native: `pacer-repos` removal under the `repos` lock with JavaScript JSON reads and writes; lone surrogates, deep nesting, non-regular registry paths and engine errors forward. URL `repo_key` remains in `pacer-config::host`. |

`test/config-settings-parity.test.ts` regenerates and verifies the shared
`test/fixtures/config-settings/settings.json` corpus from the TypeScript reference.
Use `UPDATE_CONFIG_SETTINGS=1 bun run test test/config-settings-parity.test.ts` only
when intentionally refreshing that reference. Rust integration tests verify the
same results, errors/hints, previous values, sources, diff/undo and exact YAML
bytes, plus the existing shared ECMAScript whitespace/order corpus. The number
formatter uses `ryu-js` to preserve ECMAScript number spelling and IEEE-754 rounding;
terminal limits count UTF-16 code units. Native `config.set` pure-key cutover
evidence belongs with the fixed `native-config` live fixture and targeted parity tests.

## Unregistered public ops (Forwarded by default)

Pinned against `stdio_hello.json` v3 (`234` ops). The Rust registry lists
native names in the detailed table above; every other public op remains TypeScript-owned
until a cutover PR registers it and updates this ledger. Rows already named in
the table above are omitted here. Owner streams follow
`docs/specs/2026-10-20-rust-host-migration-design.md` §2 and the 2026-11-01
reconcile plans. Counts are op prefixes, not reviewable PR slices.

No prefix aggregates remain: every v3 public op in `stdio_hello.json` is named
in the detailed Native or Forwarded table above (including HTTP-native plugin
ops and selective forwards such as `mode.hold` without `until`).

Total unregistered (not in the detailed table): **0**.
Total native: **136** of 225 (124 on the Rust stdio registry plus 12 HTTP-native
`plugin.*` ops). Fifty-nine of these selectively forward some inputs or effects to TypeScript:
`config.set`, `mode.hold`, `routing.route`, `task.retry_options`, `repo.list`, `repo.add`, `repo.remove`, `task.stop`,
`task.wait`, `task.review`, `project.messaging.get`, `project.messaging.set`,
`project.messaging.remove`, `project.strategy.list`, `project.strategy.get`,
`project.strategy.set`, `project.strategy.remove`, `msg.inbox`, `msg.log`, `msg.read`, `msg.policy`, `tree.status`,
`discovery.set`, `discovery.respond`, `discovery.list`, `discovery.network.get`,
`discovery.network.set`, `runner.add`, `attention.dismiss`, `attention.snooze`, `desktop.reconcile.request`,
`desktop.reconcile.cancel`, `assistant.status`, `assistant.candidates`,
`assistant.settings.get`, `assistant.settings.set`, `assistant.conversations`,
`assistant.conversation`, `assistant.turn`, `assistant.delete`,
`assistant.card.record`, `assistant.card.refresh`, `dispatch.dependencies.waive`, `insights.summary`,
`dispatch.refresh`, `dispatch.enforcement.consent`, `strategy.preview`, `executor.setup.models`,
`issue.import`, `issue.search`, `strategy.build`, `executor.setup.candidates`, `setup.init`,
`setup.health` and `doctor.run`.
Total still not native (v3 − native set): **89**.

When a prefix cutover lands, move those ops into the detailed table as Native
or keep an explicit Forwarded row with the residual reason. Do not delete a
prefix row until every op under it is accounted for.
