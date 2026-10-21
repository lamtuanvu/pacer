# Plugin system: minimal host, plugins for everything else, Rust by strangler

Status: design agreed 2026-10-19 (see Decisions); ready for the M0 implementation plan. Nothing is built.

## Problem

pacer grows by adding adapters to the core: usage readers, execution backends, remote hosts, endpoint vendors, classifiers, notifiers, planner installers and client surfaces. Every one of them is hard-wired behind a `switch` or a static list (`src/usage/index.ts`, `src/exec/backend.ts`, `src/classify/registry.ts`), ships in the one binary, and is maintained by the same person. That does not scale to the product goal: pacer as the one place a team manages agentic software development, with a small open core and a growing set of capabilities, some of them commercial.

The core is also tied to the Bun runtime. The compiled binary embeds it, the status line and hooks pay its start-up cost, and remote hosts are kept Bun-free only by design discipline ([ADR remote-hosts-ssh](../decisions/2026-10-15-remote-hosts-ssh.md)).

## Goal

- The host (`pacer serve`) holds only what every plugin needs and nothing a plugin could provide.
- Every adapter in the table below is a plugin against one versioned contract, and the bundled ones are the open reference implementations of that contract.
- Plugins are written in TypeScript or Rust against an SDK that hides the transport.
- The host moves to Rust without a feature gap, behind the versioned client API, one module at a time.
- Commercial plugins can be shipped against the same contract with no change to the open core and no entitlement logic in it.

Done means:

- A fresh install behaves exactly as today: one binary, bundled reference plugins, same CLI, TUI, web app and desktop.
- A plugin written from the protocol document and an SDK alone can add a usage reader, an executor or a policy without touching the host.
- A crashing, slow or over-privileged plugin degrades one capability and is visible as such; it never takes the service down.
- The conformance suite passes against the TypeScript host and, later, the Rust host.

## Non-goals

- A hosted plugin registry, the account portal, pricing, product naming, and the design of any individual commercial plugin. Each gets its own spec.
- Moving routing or strategy configuration out of the core. They are the product.
- Sandbox enforcement in phase 1. Capabilities are declared from day one and enforced when the wasm transport lands.

## Decisions taken while brainstorming

| Question | Decision |
|---|---|
| First plugin areas | All four: providers, execution targets, workflow and policy, surfaces and analytics. The host is general from the start. |
| Open-core line | By feature tier. Free: host, protocol, SDKs, reference plugins. Commercial: advanced plugins, regardless of team size. |
| Plugin authors | First-party now, ecosystem later. Capability declarations from day one, enforcement later. |
| Why Rust | Runtime-free binary, start-up and memory, a sandboxed wasm plugin host, credibility. |
| Sequencing | Strangler. Contract first on the TypeScript host, then a Rust host behind the same API, modules migrate one at a time. |
| Mechanism | One contract, two transports: JSON-RPC over stdio to a subprocess (phase 1), in-process wasm component on the Rust host (phase 2). |

## 1. Host and contract

### What stays in the host

The versioned client API ([docs/protocol.md](../protocol.md)), the plugin registry and lifecycle, the capability broker, the event bus, the task store and activity log, config, strategy and routing, and the pacing engine (ranking, slots, verdicts). After extraction nothing else remains.

### The plugin protocol

A second versioned protocol, independent of the client protocol (3.0.0 today), so the two evolve separately. Messages are JSON in two directions:

| Direction | Content |
|---|---|
| Host → plugin | Calls on the extension points the plugin contributes (section 2). |
| Plugin → host | Capability calls the plugin declared: `tasks.read`, `events.subscribe`, `process.spawn`, `fs.read` (scoped to declared roots), `net.http`, `secrets.resolve` (by reference, value never returned to the plugin), `config.get` (the plugin's own slice), `entitlement.report`, `log`. |

Extension-point and capability names, their schemas and their deadlines are the protocol. The schema source of truth is zod in this repository, as for the client protocol; it generates the plugin protocol document and the Rust types, and a test fails when either is stale (P11).

### Manifest

`pacer-plugin.json`, one per plugin folder:

| Field | Meaning |
|---|---|
| `id`, `version`, `publisher` | Identity. `publisher` keys the signature check and a future registry. |
| `host` | Plugin protocol range the plugin needs, semver. |
| `contributes` | Extension points served, each with its own options (for example the provider ids a usage reader covers). |
| `capabilities` | Host capabilities required, with scopes (directories for `fs.read`, hosts for `net.http`). |
| `entry` | Phase 1: an executable path relative to the folder. Phase 2: a `.wasm` component. |
| `reentrant` | Whether the host may issue concurrent calls. Default false. |
| `tier` | `free` or `commercial`. Informational; the host never acts on it. |

### Transports

- **Phase 1, subprocess.** The host spawns the entry and speaks JSON-RPC 2.0 over stdio, reusing `src/api/stdio.ts` framing and error mapping. The host keeps the process alive, restarts it on crash and applies a deadline to every call.
- **Phase 2, wasm.** The Rust host loads the component in process with wasmtime. Capabilities are host imports, so the manifest is enforced by construction. Plugins that need `process.spawn` keep the subprocess transport; WASI has no process creation.

### SDKs

`@pacer/plugin` (TypeScript) and `pacer-plugin` (Rust crate). Each exposes typed handlers per extension point, typed capability clients, the manifest type, a fixture plugin and a test harness that drives a plugin without a running host. Transport is invisible to the author.

## 2. Extension points

| Extension point | Reference plugin extracted from | Host calls |
|---|---|---|
| Usage reader | `src/usage/` Claude, Codex, BytePlus, metered | `read(account) → { windows, capturedAt, stale, error? }`, 10 s deadline |
| Executor | `src/exec/direct.ts`, `src/exec/orca/` | `available(strategy)`, `runAttempt(task, cfg) → stream of progress events then outcome`, `stop(attempt)` |
| Host runner | `src/remote/` (SSH) | `open(host)`, `run(session, command)`, `fetch(session) → bundle` |
| Endpoint vendor | `src/endpoints/` | `models()`, `launchEnv(secretRef)` |
| Classifier | `src/classify/` rules, Ollama | `classify(brief) → kind`, short deadline |
| Notifier | `src/notify/` | `deliver(alert)` |
| Planner integration | `src/install/` hook and config installers | `detect()`, `install()`, `uninstall()`, `check()` |
| Surface | `app/`, `orca-plugin/`, `desktop/` | `routes()` under a namespaced prefix; read-only API client |
| Policy | none today | `before(decision) → allow / amend / veto`, short deadline |

Rules:

- The pacing engine never knows which plugin produced a reading or ran an attempt. It sees the typed result and the plugin id for attribution only.
- A plugin that needs a capability the host lacks gets it added as a host capability first (the ARCH-2 rule, applied to plugins).
- Policy fails open by default, closed only when the user configures it, and every surface shows which. A policy veto is recorded in the activity log with the plugin id.
- Routing and strategy stay in the core so no plugin can hold the host hostage.

## 3. Lifecycle

### Discovery

Two locations only: reference plugins bundled in the release, and user-installed plugins under the pacer home directory, one folder each. Nothing is loaded from the working directory or a repository. Plugins are enabled by name in config.

Operations, exposed on every surface: `plugin.list`, `plugin.add` (signed archive from a URL or GitHub release), `plugin.remove`, `plugin.enable`, `plugin.disable`, `plugin.doctor`. The CLI mirrors them as `pacer plugin …`.

### Start-up and trust

The host reads manifests, checks the protocol range, resolves capabilities against grants, and spawns each enabled plugin lazily on first use. The handshake exchanges manifest and host version; the plugin returns the extension points it actually serves. Bundled plugins are trusted. Installed plugins prompt once for their capability set, the grant is recorded in config, and a new version prompts again only when it asks for more.

### Calls

Every call carries a deadline (usage 10 s, classifier and policy a few seconds, run-attempt long-lived and streaming). Calls to one plugin are serialised unless `reentrant` is set.

### Failure

| Event | Host behavior |
|---|---|
| Crash | Restart with exponential backoff; after three restarts in a minute mark the plugin failing and report its extension points unavailable. |
| Deadline | The call fails with `plugin_timeout`; a usage reading becomes `stale` with the error text; a policy call applies the fail-open or fail-closed setting. |
| Failing executor | Routing skips its runners, as an unavailable backend does today. |
| Over-privileged manifest | The plugin is refused at load with the missing capabilities listed by `plugin.doctor`. |

The host never falls back silently to a built-in; after extraction there is none. Failures surface through the existing attention and activity mechanisms.

### Compatibility

Plugin protocol follows P4: additive changes need no bump, and the host serves the previous major for one pacer minor release. `plugin.doctor` lists mismatched plugins with the range they need.

### Secrets

A plugin never receives a key (P5). It receives a reference. The host injects the value into the child environment at spawn time, or resolves it inside a host capability such as `net.http` with an authorization reference.

## 4. Distribution and the commercial boundary

| Open, Apache-2.0, this repository | Commercial, separate private repository |
|---|---|
| Host, plugin protocol, both SDKs, every reference plugin, conformance suite | Advanced plugins built with the same SDKs: fleet and cloud runners, review and policy pipelines, ticket and PR integrations, team analytics surfaces |

- Reference plugins prove the contract. If a commercial plugin needs something the SDK lacks, the SDK gains it in the open first.
- Phase 1 has no registry. `plugin.add` fetches a signed archive and verifies it against publisher keys the host ships with plus keys the user adds. A hosted registry is a later, separately specified service.
- The host never checks entitlements. A commercial plugin verifies its own signed license file under the pacer home and reports status through `entitlement.report`, so surfaces can show trial, licensed or expired beside the plugin.
- The release still ships one binary with the reference plugins bundled. npm and Homebrew paths do not change. Installed plugins live in the pacer home and survive upgrades.

## 5. Milestones (strangler)

Each milestone is a complete product. If one slips, the previous one still ships.

| Milestone | Deliverable | Exit criteria |
|---|---|---|
| **M0** Contract on the TypeScript host | Plugin protocol, manifest, SDKs, `plugin.*` operations, Rust type generation from zod, conformance suite. Reference plugins extracted one extension point per PR, usage readers first, Orca executor last. | Conformance suite green; live validation (CT-11) green; fresh-install behavior unchanged. |
| **M1** Rust host as front door | Cargo workspace at the repository root: `host`, `plugin-sdk`, `protocol` (generated). The Rust binary is the installed `pacer`; it speaks the client protocol, loads plugins over stdio, and forwards unimplemented operations to the TypeScript core run as a subprocess over the existing stdio JSON-RPC. | Same exit criteria, plus Rust CI (fmt, clippy, test) on every PR. |
| **M2** Migrate the core inward | Modules move in dependency order: config; task store and activity log; event bus; pacing engine and strategy; API transports; service install. Web app embedded in the Rust binary; CLI and TUI move last. | Each move passes conformance and live validation before its TypeScript is deleted. |
| **M3** Runtime-free, then wasm | No operation forwards; the TypeScript core is removed. The wasm transport lands, usage readers first; capability enforcement switches on for installed plugins. | Binary has no embedded runtime; sandboxed reference plugin passes conformance. |

Guardrails: the Rust host never gains an operation the client protocol does not define, and no milestone may break the first public release or the Orca marketplace listing on the roadmap.

## 6. Testing

| Layer | What it covers |
|---|---|
| Conformance suite (M0) | Black-box, host-neutral. Starts a host, installs fixture plugins, asserts protocol behavior: handshake, lazy start, deadlines, crash restart and failing state, capability refusal, secret references, compatibility range, policy fail-open and fail-closed. |
| SDK harnesses | A fixture plugin and a harness per SDK, so a plugin is tested without a host. |
| Existing unit tests | Follow the code: tests for extracted modules move into their reference plugin; tests for TypeScript modules replaced in M2 retire when the Rust equivalent passes conformance. |
| Live validation | CT-11 remains the gate for every milestone that changes runtime behavior. |

## 7. Governance

- One ADR: plugin host and strangler migration to Rust.
- Constitution bump with three principles: the host is minimal and every capability a plugin could provide is a plugin; the plugin protocol is versioned under the same compatibility rule as the client protocol; the host never checks entitlements.
- Dependency direction becomes: clients → API → host core → plugin protocol → plugins.
- Open decision OD-3 (Rust CI) is resolved as required from M1.
- Extracting the Orca executor crosses the ARCH-4 boundary and needs the architecture reviewer.

## Risks

- One maintainer carries two implementations through M1 and M2. The per-milestone completeness rule makes a pause at any point safe.
- TypeScript plugins in phase 1 are compiled per platform or need Bun present. Reference plugins are bundled, so this only affects third parties, who are not expected before M3.
- TypeScript-to-wasm tooling is still maturing; M3 may sandbox Rust plugins before TypeScript ones.
- Commercial plugins need a second repository, a signing key and a license portal before the first sale. None of that is in this spec.

## Open questions

- Product name and portal for the commercial line.
- Whether the Orca panel stays a surface plugin or a client only (it reads the API today; [ADR orca-plugin-information-only](../decisions/2026-10-15-orca-plugin-information-only.md)).
- Publisher key management: shipped list only, or a key-server later with the registry.
