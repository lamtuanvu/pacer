# Machine peers: host primitives for multi-machine plugins

Date: 2026-10-28, revised 2026-10-29 after independent architecture and security review. Status: proposed, awaiting the maintainer's approval. Applies to: `src/plugins/protocol.ts`, `src/plugins/manifest.ts`, `src/dispatch/types.ts`, the executor extension point (unmerged, draft #402), `src/engine/rank.ts`, `src/engine/slots.ts`, `src/core/dispatch.ts`, `src/dispatch/**`, `src/config/project-strategies.ts`, `src/core/project-strategies.ts`, a new `src/config/project-machines.ts`, `src/api/ops.ts`, `src/api/caller-policy.ts`, `src/serve/http.ts`, a new `src/identity/` and `src/discovery/`, `app/`, `docs/protocol.md`, `docs/plugin-protocol.md`, `.project/rules/security.md`, `.project/rules/architecture.md`.
Builds on:
- [plugin system](2026-10-19-plugin-system-design.md), section 4 (what a plugin needs from the host is added to the host in the open first)
- [intelligent work dispatcher](2026-10-24-intelligent-work-dispatcher-design.md) and [ADR 0006](../decisions/0006-intelligent-work-dispatcher.md)
- [per-project strategy](2026-10-20-per-project-strategy-design.md)
- [route explanation](2026-10-28-route-explanation-design.md) (proposed; `dispatch.explain`)
- [clients over one local service](../decisions/2026-10-16-clients-over-local-service.md)
- [remote hosts over SSH](../decisions/2026-10-15-remote-hosts-ssh.md), which this spec leaves in place for SSH host runners

## Problem

One person often runs pacer on several machines: a laptop, a desktop, a build server. Each machine has its own signed-in accounts, executors, workspaces and budgets. Today a planner on the laptop cannot see or use the desktop's executors, except through the bare SSH host runner, which uses the laptop's own accounts and leaves the desktop's pacer out.

A plugin could pair machines owned by one person and let each one see and use the union of their tasks, accounts, executors and workspaces. Under plugin-system section 4, whatever such a plugin needs from the host is added to the host first, in the open. Some of it must land before the executor extension point freezes its first version.

This spec covers only those open host pieces. It does not specify any plugin's peer protocol, transports or pairing exchange.

## Goals

1. **Each machine owns its own work.** A task, its attempts, results and verdict exist only on the machine whose executor runs it. Other machines read and act on it through that machine's API; nothing is copied or mirrored.
2. A plugin can contribute runners and observations that belong to another machine, and the host attributes, ranks and displays them correctly.
3. **No transitive reach.** Work never travels more than one hop: a machine never offers, routes or re-routes a peer's request to a third machine or back to the requester.
4. On the score-based ranking path, routing prefers local work when candidates score within a small tolerance of each other (section 4), and recovers when a remote slot is refused.
5. A workspace can opt out of running anywhere but on its own machine; a request can pin a machine.
6. Pacer installs on the same LAN can notice each other and offer the user to pair them, without opening any connection.
7. Pacer code never moves provider credentials between machines.

## Non-goals

- A plugin's peer protocol, transports, pairing exchange and federation of read models. The open host never installs pacer on another machine.
- Pairing machines owned by different people, and mobile clients.
- Any change to the bare SSH host runner or to SEC-1, SEC-2 and SEC-6.

## Threat model

- **Installed plugins that hold `net.p2p` are fully trusted code.** They run as subprocesses as the same OS user (plugin-system: sandboxing is not enforced on the subprocess transport, and `net.p2p` plugins stay on it). Such a plugin could read files under `$PACER_HOME` directly. The rules below are host guarantees against *buggy* plugins and against *remote* attackers, not isolation from a malicious installed plugin.
- **A paired peer is effectively trusted with this user account.** A peer that can submit work can, by design, have an agent run arbitrary commands on this machine as this user, and the `manage` tier adds an interactive terminal. Peer tiers (section 7) reduce the API surface a forwarded request can reach, add audit and revocation, and stop a forwarding bug from reaching admin operations. They do not contain a hostile peer. Pairing must be treated as granting control of the machine.
- **Anyone on the LAN is untrusted.** Everything in an mDNS record is attacker-controlled.

## 1. Machine identity

Each pacer home gets a long-lived **machine identity** on first start of a version with this feature (`src/identity/`):

- An ed25519 key pair. On macOS the private key is stored in the login Keychain (service `pacer`, account `machine-identity/<homeTag>`), as endpoint keys are under SEC-2; elsewhere at `$PACER_HOME/identity/machine.key` (0600, directory 0700, written atomically under SEC-7). `homeTag` is the first 16 hex characters of `sha256("pacer-home/v1" 0x00 realpath(PACER_HOME))`. The install salt used for clone detection is keyed the same way: Keychain account `machine-install-salt/<homeTag>` on macOS, `$XDG_STATE_HOME/pacer/install-salt/<homeTag>` elsewhere. Keying both by home keeps several pacer homes on one machine (a sandbox or test home beside the main one) from sharing an identity or overwriting each other's items. The public key, base32-encoded, is the **machine id**.
- A **machine name**. Until the user sets one, it is `pacer-` plus four random characters, so a host name such as "Alex's MacBook Pro" is never advertised by default; the ask-once network prompt (section 8) shows the name and offers to change it. Read with `machine.get`, changed with `machine.set {name, expect_rev}` (typed `conflict` on a stale `expect_rev`, ARCH-3) and `pacer machine rename <name>`. Names are display-only and never identify a machine.
- The private key is never returned by any operation, event or log, and `$PACER_HOME/identity/` is excluded from `doctor` output and support bundles.
- **Clone detection.** The host records a per-installation salt outside `$PACER_HOME` (macOS Keychain, or `$XDG_STATE_HOME/pacer/install-salt/<homeTag>`). If `machine.json` is present but the private key or a matching salt is not, the home was copied (backup restore, dotfile sync, cloned VM). Before creating anything the host records `cloneDetected` in `machine.json`; if the key was missing it then creates a new key and salt (same name, next revision) so the machine keeps working. `machine.get` reports `cloneSuspected` until `pacer machine rotate` clears the record.
- **Rotation.** `pacer machine rotate` creates a new key and emits a `machine.rotated` host event with the old and new ids, signed by the old key with plugin id `pacer` and purpose `rotate`, so a plugin can tell peers. Peers that cannot be told must pair again.

**Signing.** A new capability, `identity.sign`, lets a granted plugin ask the host to sign a payload. The host never signs raw bytes. It signs

```
"pacer-machine-sig/v1" 0x00 plugin_id 0x00 purpose 0x00 payload
```

where `purpose` must be one of the purposes the plugin declared in its manifest scope for `identity.sign` and matches the `PLUGIN_ID` pattern (lowercase letters, digits and hyphens, no NUL). The plugin id `pacer` is reserved for host-originated signatures and refused at plugin install. Verifiers check the prefix, plugin id and purpose. Every signature is logged (plugin, purpose, SHA-256 of the payload). Because of the prefix, the machine key cannot sign a TLS handshake transcript; a plugin that needs a transport key generates its own and has the machine key certify it once with the `transport-key` purpose. For that purpose the payload is fixed: `"transport-key/v1" 0x00 tk` with `tk` the raw 32-byte public key, so the host can check that a certificate certifies exactly that key. The host records, per plugin, the transport key it most recently certified; that is the plugin's **current** transport key. A new `transport-key` signature supersedes the previous one, and `pacer machine rotate` invalidates all of them.

Activity and task records carry the machine id, which makes records from several machines distinguishable. The docs note that this is a stable device identifier, relevant when pasting logs publicly.

## 2. Task ownership

- A task is created by, stored by and runs on the machine whose runner executes it (the **owner**). Its attempts, worktree, result branch, acceptance run and verdict live there.
- When a planner on machine A chooses a runner on machine B, A's host keeps the request as a **routing record** (the pre-task state it already has while ranking, re-evaluating or queueing) and hands it to the contributing plugin's executor, which **creates the task on B** through B's API. Once B accepts, A keeps only a pointer `{owner, taskId}`; the task itself lives on B, and A's surfaces show it through the plugin's union view, labelled with B. The results of `dispatch.submit` and `task.delegate` gain an additive `owner` field (machine id; absent means this machine) so the planner can `pacer wait --on <machine>`.
- **Children stay with their parent's owner.** `dispatch.child` calls run on the machine that owns the parent and rank only that machine's local runners, so dependency trees and "review after required children are accepted" never cross machines.
- Review happens on the owner: diffs are read from it, acceptance runs there, and the verdict is recorded there with `reviewedFrom: <machine id>`. Pulling a result branch to another machine is a user action through git, not a copy of the task.
- The owner's task record carries `requestedBy: <machine id>` for work submitted by a peer.

**ARCH-7.** ARCH-7 describes SSH host runners, which keep their bundle-and-local-acceptance model. Execution on a paired machine is a second, different model: the remote machine runs pacer and owns the task. This needs an ADR (Governance) and an amendment narrowing ARCH-7's wording to "SSH host runners".

## 3. Origin on runners and observations

Candidates and observations gain an **origin**, added as optional fields: on `observationScopeSchema` and `candidateSchema` in `src/dispatch/types.ts` today, and on the executor extension point's runner schema in its first version (draft #402):

```ts
origin?: {
  machine: string;      // machine id that owns the account and would own the task
  plugin: string;       // contributing plugin id
  hasCheckout?: boolean // the owner already has a checkout of the task's repository
}
```

Rules:

- **Host-derived locality.** An entry with no `origin` is local only if it comes from a built-in or from a plugin without `net.p2p`. An entry from a `net.p2p` plugin with no `origin`, or with `origin.machine` equal to this machine's id, is rejected and reported by `plugin.doctor`. There is no plugin-set "re-exportable" flag; the host decides.
- **Only local entries are published.** `capability.runners.local`, which a `net.p2p` plugin uses to read this machine's runners and observations for publishing to peers, returns only entries this machine owns *and runs itself*: the same predicate as section 5 and SEC-14, so SSH host runners (`@host`) are never published. A plugin that republishes data it holds by other means is outside host control and part of the trust placed in installed plugins.
- **Canonical id.** A remote runner's id is `peer:<machine id>/<runner id on the owner>`, for example `peer:mf3k…q2/claude-code#claude1`. It is parsed by splitting on the first `/`: the left part is `peer:` and a machine id, the remainder is a complete runner id on the owner. A `peer:` id never parses as a local runner id (`src/config/runner-id.ts` rejects `:` and `/`). Only the owner's *local* runners are published, so the remainder never contains `@host` (section 5). Pins (section 6) may use the full id or an unambiguous machine-id prefix; machine names are never accepted in ids. Project strategy entries and global routing lists do **not** accept `peer:` ids in this version: the strict, `version: 1` strategy files would reject them on downgrade, and pins plus `machines` cover the stated needs. Storing remote runners in strategies is an open decision.
- **Attribution.** Rankings, `dispatch.explain`, tasks and surfaces show remote runners with a host-rendered remote marker and the machine name (for example `claude-code#claude1` ⇄ `studio-mac`). Names are sanitized (control and bidirectional characters stripped, 64 characters) everywhere they are rendered.
- **Budgets stay per machine.** A remote observation informs ranking. Slot accounting for that account belongs to its owner (section 5).

## 4. Locality in ranking

`src/engine/rank.ts` has three orderings: the **score path** (known/unknown, then score, then configured order), followed by an **account-pacing pass** that reorders accounts of the same `agent:kind` within the positions they already hold (fill/yield or headroom, then policy order); the **configured-selection path** used by per-project `executors` (known/unknown, then configured order; scores reassigned from position); and the **`priority` policy path** (policy list grouped by verdict; scores reassigned from position). The dispatcher spec adds a canonical-id tie-break in step 5; current `rank.ts` does not have it.

Locality applies **only on the score path**, never on the configured-selection or `priority` paths, so it never reorders an order the user configured. On the score path it runs after the score sort and before the account-pacing pass, and bands are computed separately within the known group and within the unknown group. The account-pacing pass then groups by `machine:agent:kind` instead of `agent:kind`, so it paces accounts on each machine among themselves and never moves a local runner behind a remote one inside a band (or the reverse). Without remote runners, every runner is on this machine and the pass behaves exactly as today.

Scores are floats computed from each candidate's own observations and are rarely identical, and some policies produce zero or negative scores (`even`, `cheapest-first`). Locality therefore works on deterministic **bands**: sort by score as today, then walk from the top; a candidate joins the current band when its score is at least `bandTop − LOCALITY_TOLERANCE × max(|bandTop|, 1e-9)`, otherwise it starts a new band with itself as `bandTop`. `LOCALITY_TOLERANCE` is a named constant, 0.05. Exact ties always share a band. Within a band the order is:

1. a local runner,
2. a remote runner with `origin.hasCheckout`,
3. any other remote runner.

Within a band, configured order then breaks remaining ties. Locality never overrides eligibility or a strategy rule, and never overrides a pace difference larger than the tolerance. `dispatch.explain` reports it as the reason code `locality`.

**Which remote runners are candidates.** Remote runners are contributed by plugins, not listed in strategies (section 3), so the host adds them as follows:

- **Score path.** After the rule's executors (or all configured runners when the rule lists none), the host appends every eligible remote runner whose agent appears among those local candidates, or every eligible remote runner when the rule lists none. Their configured order comes after every listed runner, in canonical-id order.
- **Configured-selection and `priority` paths.** Remote runners are not candidates unless the request pins a machine (section 6).
- **`machines: local-only` and peer requests** remove them as described in sections 5 and 6.

The executor extension point (draft #402) is where plugins contribute the runners; this rule decides how the host ranks them.

## 5. Peer requests, slots and re-routing

**Requests from a peer are local-only.** A request authenticated with a peer credential (section 7) is ranked, dispatched and re-routed only over runners whose origin is this machine **and that run on this machine**: SSH host runners (`@host`) are excluded, because driving another host would be a second hop. A pin to another machine in a peer request is refused with `peer_not_local`. `caller-policy` gains this rule next to the existing executor-session rule.

**Responses to a peer are local-only.** Every response to a peer-credential request, and every event streamed to one, contains only entries owned by this machine and running on it: runners, observations, budgets, tasks and workspaces. Entries that came from another peer or describe SSH host runners are filtered out. Together these rules make Goal 3 hold for listings, events and dispatch.

**Slot claims.** For a remote runner, the slot claim happens on the owner. The executor point's `runAttempt` may fail fast, before the task is created, with a typed `slot_refused` outcome. The requesting host:

1. treats it like the dispatcher's existing "reservation lost" path (dispatcher spec, step 6): exclude that runner for this request and re-evaluate the remaining candidates, within the same bounded retry count,
2. when candidates run out, queues or fails the request exactly as for local exhaustion,
3. tells the planner through the existing attention and event channels that the route changed.

`slot_refused` does not count as an executor failure. After three consecutive refusals from the same remote runner, the host backs it off for that runner's next observation interval. A refusal after any attempt output, or a lost connection after the remote task was created, is not `slot_refused`: it is `remote_lost`, the task stays on its owner, and the requester never re-routes it (no duplicate execution).

**Local counters.** A remote attempt never counts against the requesting machine's `byExecutor`, `byHost` or `local` slot use. Preview estimates remote slots from the owner's published observations only.

## 6. Workspace opt-out and pinning

Each workspace gains a machine setting, stored outside the strictly parsed project-strategy file (`src/config/project-strategies.ts` uses `version: z.literal(1)` and fails closed on any parse error) in a separate `$PACER_HOME/project-machines.json`, read and written by `src/config/project-machines.ts` under its own lock, atomically (SEC-7):

```ts
interface ProjectMachinesEntry { rev: number; machines: "any" | "local-only" } // absent entry means "any"
```

- **Separate operations.** `project.machines.get {repo}` and `project.machines.set {repo, machines, expect_rev}`, where `expect_rev` is checked against the machines entry's own `rev` (typed `conflict`, ARCH-3); `expect_rev: 0` creates an absent entry, and setting `any` keeps the entry with a new `rev`. `project.strategy.set` and its `rev` are unchanged. The project strategy view gains additive `machines` and `machinesRev` fields. CLI: `pacer project machines set local-only` and `pacer project machines show`.
- **Removal.** `project.strategy.remove` leaves the machines entry in place; `project.machines.set {machines: "any"}` resets it.
- **Downgrade.** An older pacer never reads `project-machines.json` and keeps delegating; it has no support for paired machines, so ignoring the setting there is safe.
- **Failure.** If `project-machines.json` cannot be read or parsed, remote candidates are excluded for every workspace (fail closed to `local-only`), local delegation continues, a pin to another machine fails with `machines_local_only`, and `doctor` reports the file.

With `local-only`, ranking drops every non-local runner for that workspace and `dispatch.explain` reports `machines_local_only`. For peers, `project.machines.get` is in the `base` tier and `project.machines.set` in `manage` (section 7).

**Pinning.** `dispatch.submit`, `task.delegate` and `routing.route` gain an optional `machine` parameter (machine id or unambiguous prefix; `local` for this machine), and the CLI gains `--on <machine>`. A pin restricts candidates to that machine's runners whose agent appears in the request's selection or rule (all of that machine's runners when there is none); it works on every ranking path. Errors, documented in `docs/protocol.md` as `CoreError` codes:

| Code | When |
|---|---|
| `machines_local_only` | a pin to another machine for a `local-only` workspace |
| `machine_unknown` | no paired machine matches, or the prefix is ambiguous |
| `machine_unreachable` | the pinned machine is offline; the request is not re-routed elsewhere |
| `peer_not_local` | a peer request pins a machine other than this one |
| `machine_no_candidates` | the pinned machine has no eligible runner whose agent appears in the request's selection or rule |

## 7. Peer credentials

A plugin forwards streams it has authenticated itself to the local service using a **peer credential**. Forwarded traffic goes to a dedicated loopback endpoint, a Unix socket at `$PACER_HOME/run/peer.sock` (0600, directory 0700) that the service opens only while a `net.p2p` plugin is enabled and that accepts only `ppt_` credentials. When that path would exceed the platform's socket path limit (104 bytes on macOS, 108 on Linux), the socket goes in a per-user runtime directory: `$XDG_RUNTIME_DIR` on Linux when set, otherwise `pacer-<uid>` under `$TMPDIR` (per-user on macOS) or `/tmp`. The name inside it is `<first 16 hex of SHA-256(PACER_HOME)>.sock`, and its path is written to `$PACER_HOME/run/peer.sock.path`. A fallback directory is created with mode 0700; if it already exists, it must be a real directory (checked with `lstat`, not a symlink) owned by the current uid with mode 0700. Otherwise, or if no path fits, the service reports `peer_socket_unavailable` and `doctor` shows it. Before connecting, the plugin checks that the socket is owned by the current uid. The owner token is refused there, so a plugin that forwards with the wrong credential fails closed instead of gaining owner power. The 127.0.0.1 HTTP listener keeps refusing `ppt_` credentials.

**Minting.** Peer credentials are minted only through plugin → host capability calls on the plugin's own stdio channel, not through client operations: `capability.peerToken.create {peerMachine, tiers}` and `capability.peerToken.revoke {peerMachine}`, gated by `net.p2p`. `create` succeeds only for a peer machine id that the local user confirmed in a host-rendered pairing confirmation (section 8). The host:

- issues `ppt_<64 hex>`, returns the plaintext once, stores only its hash, compares in constant time,
- binds it to one peer machine id and its tiers, with an optional expiry,
- audits every create and revoke in the activity log,
- lists active peer credentials in settings with a revoke action; revoking closes that credential's SSE/WebSocket streams and live sessions.

**Tiers.** Scope is an allow-list of named operations and routes, like today's `pwg_` and `pet_` tokens (`src/serve/http.ts`). Anything not listed is denied. Responses and events are filtered to this machine (section 5). The list is kept as data next to `caller-policy` so the conformance test reads the same list.

| Tier | Operations and routes | Default for a personal pairing |
|---|---|---|
| `base` | Reads: `snapshot.get`, `version.get`, `task.list`, `task.get`, `task.log`, `task.diff`, `task.wait`, `dispatch.list`, `dispatch.tree`, `dispatch.wait`, `dispatch.events`, `dispatch.dependencies`, `dispatch.preview`, `dispatch.explain` (once it lands), `dispatch.models`, `routing.route`, `routing.status`, `runner.list`, `account.list`, `repo.list`, `project.strategy.get`, `project.strategy.list`, `project.machines.get`, `limits.check`, and the client event stream. Work on this machine (local runners only): `dispatch.submit`, `task.delegate`, `dispatch.answer`, `dispatch.retry`, `dispatch.stop`, `dispatch.review`, `task.ask`, `task.answer`, `task.retry`, `task.stop`, `task.review`, `task.request_review`. | on |
| `manage` | `terminal.create`, `terminal.list`, `terminal.rename`, `terminal.close` and the terminal WebSocket route; `session.create`, `session.resume`, `session.end`, `session.context`, `task.session`, `task.takeover` and the session WebSocket route; `account.signin`, `account.test`, `account.remove`; `runner.block`, `runner.unblock`, `runner.reorder`, `runner.settings.get`, `runner.settings.save`; `project.strategy.set`, `project.strategy.remove`, `project.machines.set`; `update.check`, `update.apply`. | on, can be turned off per peer at pairing or later |

**Never allowed** for any peer credential: `plugin.*`; `config.set`; `host.*`; `service.install` and token operations; `desktop.*`; `repo.add`, `repo.remove`; operations that carry an endpoint key (`account.add`, `account.edit`, `account.adopt`, `account.models`), so endpoint keys are entered only on the machine that stores them; `session.file.read`; `dispatch.child` (children are created by the owner's executors, section 2); `dispatch.dependencies.waive`, `dispatch.learning.reset`, `dispatch.enforcement.*`, `dispatch.refresh`, `limits.refresh`; app session exchange and codes; every `capability.*` method; `identity.sign`.

**What tiers mean.** Tiers scope the API a forwarded request can reach; they are not privilege containment (threat model). `manage` includes an interactive terminal as this user, so it is full control of the machine, and the host's pairing confirmation says so in those words. `base` also lets agents run commands here by design.

Requests with a peer credential are logged with the peer machine id; owner task records carry `requestedBy` and verdicts `reviewedFrom`.

## 8. LAN discovery and the pairing prompt

A new open module, `src/discovery/`, presence only. It can be turned off (`discovery: off` in config and a settings toggle).

**Advertising asks once per network.** Listening for adverts is always on unless discovery is off. On a network it hasn't seen (identified by the gateway's MAC address and the SSID where available), the host asks once: "Let your other machines find this one on *home-wifi*? It will appear as **pacer-k3x9**." The prompt shows the exact name that will be advertised and offers to change it. It advertises only on networks where the user said yes. The answer is stored per network under `$PACER_HOME/discovery/` (0600, SEC-7) and can be changed in settings.

**The advert.** mDNS service `_pacer._udp.local`, answering only link-local sources and with bounded record sizes (RFC 6762). The TXT record holds:

- a random **per-network discovery id** (not the machine id, and rotated when the network's answer is reset),
- the machine name,
- the pacer version,
- opaque `hints` a pairing plugin may set, published only where advertising is on.

It never carries the OS user name or the machine id, and the module never opens a connection to anything it discovers.

**The prompt.** When the host sees a discovery id that is new and not silenced:

- the app, desktop notification and `pacer discovery ls` show "Found pacer on **studio-mac** (unverified name)",
- a warning is added when the name matches a machine already paired,
- actions: **Pair**, **Later** (silences that discovery id for 7 days), **Not mine** (silences it permanently), **Stop on this network** (no more prompts on this network),
- at most one prompt per discovery id per silence period, and at most three prompts per hour in total.

**Operations, events and CLI.** `discovery.list`, `discovery.respond {discoveryId, action}`, `discovery.network.get` and `discovery.network.set {network, advertise, expect_rev}`; the client event `discovery.found`; CLI `pacer discovery ls`, and one verb per action: `pair`, `later`, `ignore` (Not mine) and `mute-network` (Stop on this network); `pacer discovery network` shows and changes advertising per network. `discovery.respond` is callable only by an interactive local client (app cookie session or CLI with the owner token), never with a peer credential or by a plugin.

**Handing over to a plugin.** A new `pairing` extension point carries the hand-over. A plugin that declares `contributes.pairing` receives **Pair** as a host → plugin `pairing.start {discoveryId, hints}` call (deadline 5 s; result `{accepted: boolean}`). The host keeps no list of plugin ids. With no plugin declaring `contributes.pairing`, **Pair** opens a local page in the app that explains machine pairing in neutral terms and says that pairing is provided by plugins. It lists no plugins and never builds URLs from discovered values.

**Pairing confirmation contract.** A short authentication string (SAS) derived only from the two long-term keys can be ground by a man in the middle, because keys are cheap to generate. The pairing contract therefore requires commit-then-reveal, and the host computes and renders the SAS:

1. **Keys first.** Over a channel already authenticated with the two transport keys, both sides exchange and fix their machine id and certified transport key before any nonce is sent. Nothing exchanged later may change them.
2. **Commit.** The initiator generates a fresh 32-byte nonce `n_i` and sends a commitment `C` over its nonce and both identities and transport keys (exact encoding in step 4). Only then does the responder send its fresh nonce `n_r`, and the initiator reveals `n_i`.
3. **Hand to the host.** Each plugin passes the transcript to its host with `capability.pairing.confirm {role, idInitiator, pluginInitiator, tkInitiator, certInitiator, idResponder, pluginResponder, tkResponder, certResponder, commitment, nonceInitiator, nonceResponder}`. Each `cert` is the `identity.sign` signature, purpose `transport-key`, over the fixed payload for that `tk`, made by that side's plugin (`plugin*` is that plugin's id), certifying the key for that machine id (section 1).
4. **Host checks and renders.** The host:
   - checks that the slot named by `role` holds this machine's id and its current certified transport key, and rejects the transcript otherwise,
   - verifies each certificate against the matching machine id, plugin id and the fixed `transport-key` payload for that `tk`,
   - rejects a nonce it has already seen in a pending or confirmed transcript (it keeps hashes of nonces from confirmed pairings and from pairing windows still open),
   - recomputes `C` and rejects a mismatch,
   - computes `SAS = (first 32 bits of SHA-256("pacer-pair-sas/v1" 0x00 transcript)) mod 10^6`, shown as 6 digits (about 20 bits, as in Bluetooth numeric comparison).

   **Encoding.** Machine ids and transport keys are their raw 32-byte public keys, nonces are raw 32 bytes, certificates are raw 64-byte signatures. Plugin ids are their ASCII bytes. `transcript` is `idInitiator, pluginInitiator, tkInitiator, certInitiator, idResponder, pluginResponder, tkResponder, certResponder, commitment, nonceInitiator, nonceResponder` in that order, each prefixed with its 2-byte big-endian length; `role` is not part of it, so both sides compute the same value. Written out with the same encoding, the commitment of step 2 is `C = SHA-256("pacer-pair-commit/v1" 0x00 L(n_i) L(id_i) L(tk_i) L(id_r) L(tk_r))`, where `L(x)` is `x` prefixed with its 2-byte big-endian length; the domain tag is not length-prefixed, as in the SAS input.

   The SAS is shown with the peer's name, a short machine-id fingerprint and the tiers being granted (with the `manage` warning above). The user compares the digits with the other machine and confirms or cancels.
5. Only after confirmation does the host record `peerMachine` as user-confirmed, which is what `capability.peerToken.create` requires.

The host can only check the values the plugin gives it; a plugin that lies is outside the threat model (installed `net.p2p` plugins are trusted). The contract protects against an attacker in the network path, which is what the prompt is exposed to.

## 9. Plugin capabilities

| Capability | Grants | Scope |
|---|---|---|
| `identity.sign` | Domain-separated signatures with the machine key (section 1) | list of purposes |
| `net.p2p` | Declared consent to open network sockets and accept peer connections; owns the methods `capability.peerToken.create`, `capability.peerToken.revoke`, `capability.runners.local`, `capability.net.listening` and `capability.pairing.confirm`; may declare `contributes.pairing` | optional port range |

On the subprocess transport `net.p2p` is declarative: the host cannot stop a subprocess from opening sockets. A `net.p2p` plugin reports its listeners (protocol, address, port) with `capability.net.listening`. Settings show them labelled "reported by the plugin", and `plugin.doctor` warns when a plugin without `net.p2p` is found listening by the host's own socket check where the OS allows it.

Today a method `capability.X` is answered only when `X` is itself a declared capability (`capabilityOf` in `src/plugins/protocol.ts`). This spec changes that to an explicit method → capability map, so one capability can own several methods. Unmapped methods stay refused.

These are additive changes (two capabilities, the method map, the `pairing` extension point with `pairing.start`): the plugin protocol takes a minor version bump, `docs/plugin-protocol.md` is regenerated with its freshness test, and plugins using them declare a host range starting at that version (older hosts reject the unknown capability and extension-point names in the manifest).

## 10. Security

- **Credentials.** Pacer code never moves a provider credential or endpoint key between machines. Key-bearing account operations are never available to peers; a machine's accounts are signed in, and its endpoint keys entered, on that machine (through the `manage` tier's terminal, if the user chooses). SEC-1, SEC-2 and SEC-6 are unchanged. A peer that submits work can still have an agent read local files by design (threat model).
- **Service exposure.** The service still binds to 127.0.0.1 (SEC-3). Peers reach it only through a `net.p2p` plugin that authenticated them against a pinned paired machine key, through the peer socket, using a scoped peer credential.

**Proposed security amendment** (new rules in `.project/rules/security.md`; "Applies to" gains `src/plugins/**`, `src/identity/**`, `src/discovery/**` and `$PACER_HOME/identity/**`):

| ID | Rule |
|---|---|
| SEC-11 | The open host's only non-loopback listener is presence-only mDNS discovery: link-local answers only, bounded records, no machine id or OS user name, advertised only on networks the user approved, and it can be turned off. |
| SEC-12 | Any other network listener belongs to a plugin holding `net.p2p`, authenticates peers mutually against pinned paired machine keys before forwarding anything, and forwards only through the peer socket with a peer credential; the peer socket refuses the owner token. |
| SEC-13 | Peer credentials scope the API surface by a named allow-list per tier (section 7); they are not privilege containment. They are hashed at rest, bound to one peer machine, minted only for a peer confirmed through the SAS contract, audited, and revocable with their streams. Operations carrying endpoint keys are never peer-callable. |
| SEC-14 | Requests with a peer credential run only on runners that this machine owns and runs locally (no SSH host runners), and responses and events to a peer contain only such entries; no request or listing travels more than one machine. |
| SEC-15 | The host signs with the machine key only under the `pacer-machine-sig/v1` domain-separation format with a declared purpose, and logs each signature. |
| SEC-16 | Discovered values are untrusted: sanitized before rendering, never used to build URLs or commands, and the pairing prompt can only start pairing; completion needs keys fixed first, a commitment binding both identities and transport keys, and the SAS computed from the transcript and rendered by the host, confirmed on both machines. |

## Validation

- Unit and conformance tests: origin derivation and rejection, canonical peer ids, rejection of `peer:` ids in strategy entries, locality bands (exact ties, zero and negative scores, a 100/96/92 chain), `slot_refused` bounds and back-off, `remote_lost`, `machines: local-only`, `project-machines.json` (conflict on a stale `expect_rev`, an older pacer ignoring it, a corrupt file failing closed for remote candidates only), pins and their error codes, peer-credential tiers and the never-allowed list, owner-token rejection on forwarded requests, domain-separated signing, clone detection, and the two capabilities. They use a fixture plugin that contributes remote-origin runners.
- A three-home conformance test (A, B, C) for every chain shape: A → B → C and A → B → A through listings, events, dispatch, re-routing, pins and children, plus a peer request that would reach an SSH host runner on B.
- Pairing contract tests: a wrong commitment, a reused nonce, an uncertified transport key, a machine id or transport key different from the ones the commitment covers, and a cancelled SAS all leave the peer unconfirmed, and `capability.peerToken.create` then fails.
- Peer-socket tests: the owner token is refused on the peer socket and `ppt_` is refused on the HTTP listener; every op not in a tier's list is denied; the long-path fallback; a pre-existing fallback directory that is a symlink, owned by another uid or not 0700 gives `peer_socket_unavailable`; the plugin refuses a socket owned by another uid.
- Pairing transcript tests: a transcript whose `role` slot doesn't hold this machine's id and current transport key, a certificate that doesn't verify against its machine id, plugin id and fixed payload, and a certificate for a different `tk` are rejected.
- Ranking tests: a local and a remote runner of the same agent in one band keep locality order through the account-pacing pass; remote runners join the score path after listed runners and are absent on the configured-selection and `priority` paths unless pinned; `machine_no_candidates`.
- Discovery tests with isolated `PACER_HOME`s on loopback mDNS: ask-once networks, silencing, rate limits, sanitization, name-collision warning, and that a peer credential or plugin cannot call `discovery.respond`.
- Live validation (CT-11) of discovery and the prompt on two machines on one LAN, run manually with the maintainer's approval in advance.

## Governance

- **ADR:** machine identity and cross-machine execution (task ownership, peer credentials, one-hop rule), with an amendment narrowing ARCH-7 to SSH host runners and adding paired pacer machines to the constitution's purpose-and-scope line, which today lists local, Orca and SSH execution.
- **ADR:** LAN discovery and the neutral pairing hand-over, recording that the open host may describe plugins that provide pairing, that it can be turned off, and that it never blocks or degrades open features.
- **Security amendment:** SEC-11 to SEC-16 (section 10).
- Sections 3–6 are proposed as a design note on draft #402 so origin, `slot_refused` and `remote_lost` land in the executor point's first version.
- The architecture and protocol-compat reviewers cover sections 2–7 and 9; the security reviewer covers sections 1, 7–10.

## Open decisions

- How networks are identified on each OS for "ask once per network" when no gateway MAC or SSID is available (wired, VPN).
- Whether machine identity should also sign activity records, or only identify them.
- Whether the `manage` tier should be split further (terminal separate from account management).
- Whether project strategies and routing lists should accept `peer:` runner ids later, and how to store them without breaking downgrade.
- How the `pacer-xxxx` default name is chosen when several machines are set up at once (collisions are harmless, since names never identify a machine).
