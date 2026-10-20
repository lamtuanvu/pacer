# Rust host migration: M1 front door, M2 core inward, M3 runtime-free and wasm

Status: design agreed 2026-10-20 (see Decisions). Builds on [the plugin system design](2026-10-19-plugin-system-design.md) §5 and assumes M0 ([host core](2026-10-19-plugin-host-core-design.md), [extraction](2026-10-19-plugin-extraction-design.md)) is complete. Nothing here is built.

## Problem

M0 leaves pacer as a minimal TypeScript host with every adapter in a bundled plugin. The system design commits to a Rust host behind the same client API, reached by a strangler: a Rust front door first, modules moved one at a time, the TypeScript core and its embedded runtime removed last, then a sandboxed wasm plugin transport. The system design names the milestones but not how two runtimes share one pacer home safely, how releases ship two binaries and update them, which order the modules move in, or what happens to the TypeScript reference plugins when the runtime goes.

## Goal

- Every milestone ships a complete product with the M0 behavior: same CLI, TUI, web app, desktop, Orca panel and client protocol.
- From M1 the installed `pacer` is a Rust binary. Start-up sensitive paths (`--version`, `status --line`) run without Bun.
- During M1 and M2 an operation is answered by exactly one runtime at a time, and moving it from TypeScript to Rust is one reviewed change with a parity proof.
- At the end of M3 the release is one binary with no embedded runtime, bundled plugins are Rust, and installed plugins run sandboxed by default.

Done means, per milestone:

| Milestone | Done means |
|---|---|
| M1 | Installed `pacer` is Rust; all client-protocol transports terminate in Rust; unimplemented operations forward to `pacer-core`; Rust CI required; conformance and CT-11 green against the Rust binary; updates move both binaries as a pair. |
| M2 | The forward table is empty: every operation, route, CLI command and the TUI are native. `pacer-core` still ships only to run bundled TypeScript plugins. |
| M3 | No `pacer-core`, no `src/` TypeScript core, bundled plugins in Rust; wasm transport serves usage readers; installed plugins are wasm unless the user grants native trust. |

## Non-goals

- Changing the client protocol or the plugin protocol beyond additive fields. Both stay under P4.
- Porting the web app, the Orca panel or the desktop app. The web app keeps being built by Bun at build time and is embedded as static files. Bun becomes a build-time tool, which "no embedded runtime" allows.
- Windows. Release targets stay darwin and linux on x64 and arm64.
- A wasm build of the TypeScript SDK. Third-party TypeScript plugins stay on the subprocess transport.

## Decisions taken while brainstorming

| Question | Decision |
|---|---|
| What the M1 front door owns | The CLI entry and every client-protocol transport (`api --stdio`, `serve` HTTP, SSE and WebSocket). Operations Rust does not implement forward to a `pacer-core` child. Routes Rust does not implement are reverse-proxied to the child's internal listener. |
| How the TypeScript core ships in M1 and M2 | Two files side by side: `pacer` (Rust) and `pacer-core` (bun-compiled), signed separately, updated as a pair. |
| Who hosts plugins in M1 | The TypeScript core, unchanged. M1 adds the Rust SDK and proves it with a Rust fixture plugin against the TypeScript host. Plugin hosting moves to Rust in M2 plan 4. |
| Bundled plugins in M3 | Ported to Rust on the Rust SDK, run by re-exec of the binary (`pacer plugin run <id>`), wasm where possible. |
| Installed-plugin enforcement in M3 | Installed plugins default to wasm. A subprocess plugin needs an explicit `native` trust grant, flagged on every surface. Bundled plugins are trusted. |

## 0. Coexistence contract (M1 and M2)

Two processes run while the migration is in progress: `pacer`, the Rust front door, and `pacer-core`, today's TypeScript core compiled with Bun and run as a child. They share four things and nothing else.

### 0.1 Client protocol 3.x

The front door forwards operations as they are already defined in [docs/protocol.md](../protocol.md): JSON-RPC lines over stdio for `pacer api --stdio`, and HTTP to `pacer-core serve --internal` for `pacer serve`. Forwarding never rewrites a request or a result.

### 0.2 On-disk state and the lock protocol

All shared state is files under `$PACER_HOME`: task JSON, `strategy.yaml` and named strategies, the activity log, the event outbox and `link/latest.json`, app codes and sessions (`app/*.json`), jobs, clients and plugin config. Writers in both runtimes follow one protocol:

| Rule | Value (from `src/core/lock.ts`, `src/fsutil.ts`) |
|---|---|
| Lock file | `$PACER_HOME/orca/<name>.lock`, created with `O_CREAT | O_EXCL`, removed on release |
| Stale takeover | Lock older than 120 s by mtime is removed and retried |
| Poll interval and default timeout | 50 ms, 20 s |
| Atomic write | Temporary file in the same directory, then `rename`; JSON files end with a newline |
| Modes | Secrets 0600, directories holding secrets 0700 (SEC-7) |

Rust implements the same rules in `crates/core/src/{lock,fsutil}.rs`. A cross-runtime test runs a Bun writer and a Rust writer incrementing one counter file under one lock name for a fixed number of iterations and asserts no lost update.

### 0.3 Reverse bridge (from M2)

When TypeScript code that has not moved needs something that now lives only in Rust memory (plugin processes from M2 plan 4), it calls the front door over a unix socket at `$PACER_HOME/run/host.sock` (directory 0700, socket 0600). The bridge speaks line JSON-RPC with methods named `_host.<area>.<method>`, is never part of the client protocol, and is never reachable over TCP. `pacer-core` finds the socket through `PACER_HOST_SOCKET`; without it the TypeScript code keeps its own implementation, which keeps standalone `pacer-core` usable in tests.

### 0.4 Golden parity

Every move ships a parity suite: the same request sequence runs against the TypeScript implementation (through `pacer-core api --stdio`) and the Rust implementation (through `pacer api --stdio` with the operation native) on two copies of one fixture home. Results and resulting files are compared after normalization (timestamps, generated ids, temporary paths). A move merges only when parity, conformance and CT-11 are green. The TypeScript implementation of an operation is deleted in the same PR that makes it native, unless other TypeScript code still calls it, in which case the PR records which plan deletes it.

## 1. M1: Rust front door

### 1.1 Workspace

```
Cargo.toml                 workspace: crates/*, exclude desktop/src-tauri
rust-toolchain.toml        pinned stable, rustfmt, clippy
crates/protocol            generated types for both protocols (checked in)
crates/core                ctx, fsutil, lock, errors (grows in M2)
crates/host                bin "pacer": front door, transports, later everything
crates/plugin-sdk          lib "pacer-plugin": Rust plugin SDK
crates/fixtures            Rust conformance fixture plugins
xtask                      code generation and release helpers (cargo xtask)
```

The desktop crate stays outside the workspace in M1 to keep Tauri's dependency tree out of the host build. It may join later and reuse `crates/protocol`.

### 1.2 Generated protocol types

`docs/plugin-protocol.schema.json` exists from M0. M1 adds `docs/protocol.schema.json`, emitted from the client-protocol zod by `scripts/protocol-doc.ts`. `cargo xtask gen` runs typify on both and writes `crates/protocol/src/{client,plugin}.rs`. Staleness fails in both test suites (P11): `bun test` regenerates the schemas and compares; `cargo test -p pacer-protocol` regenerates the Rust and compares.

### 1.3 Front-door CLI

| Path | Behavior |
|---|---|
| `pacer --version`, `pacer version` | Native; prints the version embedded at build time |
| `pacer status --line [...]` | Native port of the line renderer: reads `/v2/snapshot` with a 300 ms timeout, then `link/latest.json` within 120 s, then the offline line |
| `pacer api --stdio` | Native transport (1.4) |
| `pacer serve [--port]` | Native transport (1.5) |
| everything else | `execv` of `pacer-core` with the original argv |

`pacer-core` is resolved as a sibling of the canonicalized `current_exe`. `PACER_CORE_ARGV` (a JSON array, for development: `["bun","/abs/src/cli.ts"]`) overrides it. The front door sets `PACER_BIN` to its own path in the child's environment when unset, so every place that re-execs pacer (hooks, service units, runner spawns, the bundled-plugin re-exec) writes the Rust binary, not the core.

### 1.4 `api --stdio`

A per-connection proxy: the front door spawns one `pacer-core api --stdio` per client connection and copies lines both ways. Before forwarding, it parses each request line; a method in `NATIVE_OPS` is answered locally. `NATIVE_OPS` is empty in M1. `hello`, `snapshot` and `subscribe` forward, because they carry per-connection state in the core. Line cap (1 MiB) and JSON-RPC error codes match `src/api/stdio.ts`.

### 1.5 `serve`

The front door listens on `127.0.0.1:<port>` and owns everything a client sees:

- the token (`$PACER_HOME/token`, 0600, created as `ensureToken` does), the host-header check (421), `/health`, bearer auth, cookie sessions read from `app/sessions.json`, the `sec-fetch-site`, origin and `x-pacer-client` rules, exactly as `src/serve/http.ts` orders them;
- a child `pacer-core serve --internal`, which binds `127.0.0.1:0`, prints `{"internal":{"port":N}}` as its first stdout line, trusts only `Authorization: Bearer <PACER_INTERNAL_TOKEN>` (from the environment, never argv), and keeps the pump, job, status and panel loops;
- forwarding: `/v3/ops/<op>` native when in `NATIVE_OPS`, otherwise proxied; all other `/v2`, `/v3`, `/app` routes and the session WebSocket upgrade proxied. The front door adds `x-pacer-auth: bearer` or `x-pacer-auth: cookie` so the core keeps its `terminalPresetsOnly` rule.

The child is supervised: restart with backoff (1 s doubling to 30 s), `502` with a plain message while it is down, SIGTERM then SIGKILL after 5 s on stop.

### 1.6 Rust plugin SDK

`pacer-plugin` mirrors `@pacer/plugin`: `serve(handlers)`, typed handlers per extension point from `crates/protocol`, a `Host` capability client, `PluginError`, progress notifications, and `testing::Harness` that drives a plugin in process. `crates/fixtures` builds `rust-good` (the `good` fixture's behavior), which the conformance suite runs against the host.

### 1.7 Release and update

| Item | M1 |
|---|---|
| Assets | `pacer-<os>-<arch>` (Rust front door) and `pacer-core-<os>-<arch>` (bun-compiled) |
| Manifest | Additive `companions: [{ name: "pacer-core", file, sha256, size }]` per asset |
| Bridge release | The last TypeScript-only release teaches `update.apply` to fetch, verify, smoke and install companions next to the binary. M1 ships only after it. |
| Self-repair | If `pacer-core` is missing or reports another version, the front door downloads its own version's companion, verifies it against the manifest, installs it and continues |
| Update | Stage both, smoke both (`--version`), rename core first and front door second; on failure restore both from `.bak` |
| Signing | Both binaries signed on darwin (`signLocal`) |
| npm and Homebrew | Platform packages and the formula install both files into the same directory |
| Service | Unit and plist point at the Rust `pacer` through `PACER_BIN` |

## 2. M2: move the core inward

### 2.1 Order

| # | Plan | Becomes native |
|---|---|---|
| 1 | Foundations | `crates/core` ctx, fsutil and lock parity, `CoreError` and status mapping, the op dispatcher with zod-equivalent validation from generated types, the parity harness, the reverse-bridge server |
| 2 | Config | `strategy.yaml` parse, validate, edit and migrate; ops `config.*`, `notifications.*`, `routing.get/set`, `runner.set/reorder/remove/add` (config parts), `repo.*`, `host.add/get/set/remove/suggest/repo.map`, `strategy.list/show/use/save/remove/preview` |
| 3 | Store, activity, events | Task store and ids, activity log, outbox and reducer; ops `task.get/list/dismiss/log/diff`, `activity.list`; `/v3/events` SSE and stdio `subscribe` natively from the outbox |
| 4 | Plugin host | Registry, processes, every capability, `plugin.*` ops, surfaces; bridge `_host.plugin.call` and `_host.plugin.find` for TypeScript consumers; conformance against Rust natively |
| 5 | Pacing engine | Rank, slots, verdict, mode, status, usage broker; ops `routing.status/route`, `limits.*`, `mode.*`, `delegation.*`; `status` text, `--json` and `--hook` |
| 6 | Task lifecycle | Delegate, queue drain, the `_run` runner, supervisor, executor dispatch, policy calls; ops `task.delegate/wait/stop/answer/retry/retry_all/review/ask/retry_options`, `attention.*`, `job.*`, `client.*`; the pump loop; notifier delivery |
| 7 | Terminal sessions | Session host on a PTY (`portable-pty`), screen state (`vt100`), recording and retention, attach, takeover, masking, the session WebSocket and `host.terminal`, `account.signin` terminals |
| 8 | Transports complete | Read model and snapshot (`/v3/snapshot`, stdio `snapshot`), `/v2` compatibility (unless OD-4 removed it), `/app` embedded with `rust-embed`, app auth routes, panel writer, MCP server (`rmcp`) |
| 9 | Setup, service, update, CLI, TUI | `setup.*`, `onboarding.*`, `agent.*`, `account.*`, `service.*`, `update.*`, `version.get`, `plugin.install` (Orca); every CLI command in clap; the dashboard in ratatui. The forward table is empty. |

The order follows dependencies and moves file-backed state first, where the coexistence contract alone makes a move safe. In-memory state (plugin processes) moves once its file-backed inputs are native, and its remaining TypeScript callers use the bridge.

### 2.2 Porting rule

A port plan names its TypeScript reference files. The Rust code reproduces their observable behavior: operation results, files written, events published, activity lines. Tests come from three sources: the existing TypeScript test cases for those files, transcribed to Rust; golden fixtures recorded by running the TypeScript implementation (`cargo xtask golden <area>`); and the parity suite. Behavior changes are out of scope for a port PR; a bug found while porting is fixed in TypeScript first, in its own PR, then ported.

### 2.3 Crate layout growth

`crates/core` holds domain modules by area (`config`, `tasks`, `activity`, `events`, `engine`, `plugins`, `sessions`, `setup`, `service`, `update`), mirroring `src/`. `crates/host` holds transports (`stdio`, `http`, `ws`, `mcp`), the CLI and the TUI. Dependency direction stays clients → API → host core → plugin protocol → plugins (ARCH-12), checked by a `cargo xtask deps` test.

## 3. M3: runtime-free, then wasm

### 3.1 Bundled plugins in Rust

Every bundled reference plugin (`pacer-usage`, `pacer-classify`, `pacer-notify`, `pacer-endpoints`, `pacer-planners`, `pacer-ssh`, `pacer-exec-direct`, `pacer-exec-orca`) is rewritten on `pacer-plugin` in `plugins-rs/<id>/` and linked into the binary; `pacer plugin run <id>` serves it. Each passes its TypeScript harness cases (transcribed) and the conformance suite. The TypeScript versions move to `examples/plugins/` as SDK examples, not shipped. Porting may start in parallel with M2 from plan 4.

### 3.2 Removing the TypeScript core

When M2 has emptied the forward table and 3.1 is done: `src/` and `pacer-core` are removed, the manifest drops `companions`, and `update.apply` deletes a stale `pacer-core` beside the binary. Bun remains for `app/` builds, `packages/plugin-sdk`, the conformance runner and scripts.

### 3.3 Wasm transport

wasmtime with the component model. A WIT world `pacer:plugin@2` declares extension-point exports and capability imports; it mirrors the plugin protocol and a staleness test compares it with `docs/plugin-protocol.schema.json`. A manifest with `entry: "<file>.wasm"` selects the transport. Capabilities are host imports, so an undeclared capability does not exist for the plugin. `pacer-usage` readers that need only `fs.read` ship as wasm first; readers that need `process.spawn` stay subprocess (WASI has no process creation). The Rust SDK gains a `wasm` feature that targets `wasm32-wasip2` with the same handler API.

### 3.4 Enforcement

| Plugin | Transport | Trust |
|---|---|---|
| Bundled | subprocess or wasm | Trusted |
| Installed, wasm | wasm | Grants enforced by construction |
| Installed, subprocess | subprocess | Refused unless the user grants `native` (`plugin.enable { id, grant: true, native: true }`); every surface shows "runs unsandboxed" |

This closes the M0 executor deviation (in-process spawn under scope `*` and `env.json`) for installed executors; bundled executors remain trusted subprocesses.

## Testing

| Layer | M1 | M2 | M3 |
|---|---|---|---|
| Rust unit and integration | `cargo test` in CI, required | grows per plan | grows per plan |
| Cross-runtime lock test | added | kept | removed with `pacer-core` |
| Parity suites | none (nothing native) | one per plan | removed with `pacer-core` |
| Conformance | against the Rust binary (forwarding) and with the Rust fixture | native Rust host from plan 4 | adds wasm fixtures |
| CT-11 | Rust binary in the sandbox | every plan | every plan |

## Governance

- ADR `docs/decisions/2026-10-20-rust-front-door-and-coexistence.md` (M1) records the coexistence contract.
- OD-3 resolved at M1 plan 1: Rust fmt, clippy and test required on PRs; dependabot gains cargo.
- New rule area `.project/rules/rust.md` (M1 plan 1): error handling, no `unwrap` outside tests, argv-only process spawn (SEC-5), file modes (SEC-7), `cargo xtask` for generation.
- ARCH-12 gains the crate dependency check in M2 plan 1.
- M3 plan 2 amends the constitution: P11 generation source moves from zod to the Rust types only if the zod sources are deleted with `src/`; the plan decides which source stays authoritative (default: keep zod in `packages/protocol-schema/` as the schema source for docs and the TypeScript SDK).

## Risks

- M2 ports about 25,000 lines. Every plan leaves `main` releasable because unmoved operations forward. Pausing at any plan is safe.
- `vt100` formatted output must replay correctly in the xterm.js client that today receives `@xterm/addon-serialize` output. M2 plan 7 starts with a spike; if replay differs, the session WebSocket stays forwarded until M3 plan 2, which then cannot start before the gap closes.
- The bridge release must reach users before M1. Self-repair covers users who skip it, at the cost of a network fetch on first run.
- Two binaries double signing and notarization work in M1 and M2.
- One maintainer carries both runtimes for M1 and M2; the parity suite is what keeps two implementations from drifting.
- Generated Rust types from JSON Schema may be awkward for unions; `crates/protocol` may hand-write a thin layer over generated types, with the staleness test still on the generated part.

## Open questions

- Whether the desktop app moves into the workspace and replaces its HTTP client types with `crates/protocol` (cheap after M1; not required).
- Whether `/v2` is removed (OD-4) before M2 plan 8, which would remove a port.
