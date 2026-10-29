# ADR 0012: Machine identity and execution on paired machines

Status: Proposed, 2026-10-29

## Context

One person often runs pacer on several machines. Each machine has its own signed-in accounts, executors, workspaces and budgets. A planner on one machine can reach another only through the SSH host runner, which uses the planner machine's own accounts and leaves the other machine's pacer out.

A plugin that pairs machines could let each machine see and use the others' executors. Under the plugin system's rule that what a plugin needs from the host is added to the host in the open first ([plugin system spec](../specs/2026-10-19-plugin-system-design.md), section 4), the host needs a machine identity, a model for who owns remote work, and a scoped way for a plugin to forward a peer's requests. ARCH-7 describes only one remote model today: SSH hosts with no pacer installed, results returned as a git bundle and acceptance run locally.

## Decision

- **Machine identity.** Each pacer home gets a long-lived ed25519 key pair. The public key is the machine id; the private key is stored in the macOS Keychain as endpoint keys are (SEC-2), elsewhere under `$PACER_HOME/identity/` (0600) and is never returned, logged or exported. A machine name is display-only and never identifies a machine; until the user sets one it is `pacer-` plus four random characters. The host detects a copied home and offers rotation.
- **Domain-separated signing.** A plugin granted `identity.sign` asks the host to sign. The host never signs raw bytes: it signs `"pacer-machine-sig/v1" 0x00 plugin_id 0x00 purpose 0x00 payload`, with a purpose the plugin declared, and logs every signature. The plugin id `pacer` is reserved for the host. A plugin that needs a transport key has the machine key certify it with the fixed `transport-key` payload.
- **The executing machine owns the task.** A task, its attempts, worktree, result branch, acceptance run and verdict live only on the machine whose runner executes it. The requesting machine keeps a routing record and then a pointer `{owner, taskId}`. Nothing is copied or mirrored. Children stay with their parent's owner, and review happens on the owner.
- **One hop.** Work never travels more than one machine. A request with a peer credential runs only on runners this machine owns and runs itself, so SSH host runners are excluded. Responses and events to a peer contain only such entries. Only local entries are published to peers.
- **Tiered, allow-listed peer credentials over a dedicated socket.** A plugin holding `net.p2p` forwards a peer's requests to a dedicated loopback Unix socket that accepts only `ppt_` peer credentials and refuses the owner token. The HTTP listener keeps refusing `ppt_`. Credentials are minted only through plugin capability calls, only for a peer the user confirmed, hashed at rest, bound to one peer machine, audited and revocable. Each tier (`base`, `manage`) is a named allow-list; anything not listed is denied, and some operations are never allowed for a peer. Tiers scope the API surface; they are not privilege containment.
- **SSH host runners keep the ARCH-7 bundle model.** Execution on a paired machine is a second model next to it, not a replacement. ARCH-7's wording narrows to SSH host runners.

## Consequences

- Records from several machines are distinguishable by machine id. The machine id is a stable device identifier, which matters when logs are pasted publicly.
- No task is ever duplicated across machines. A lost connection after the remote task exists leaves it on its owner; the requester does not re-route it.
- Pacer code never moves provider credentials or endpoint keys between machines. Each machine's accounts are signed in on that machine.
- Pairing grants control of the machine. A peer that can submit work can have an agent run commands as this user, and the `manage` tier includes a terminal. The pairing confirmation says so.
- Installed `net.p2p` plugins are trusted code. The host's guarantees protect against buggy plugins and network attackers, not against a hostile installed plugin.
- The plugin protocol gains two capabilities and a method-to-capability map in a minor version. The client protocol gains additive fields and operations (P4, P14).
- The constitution's scope line gains execution on paired pacer machines, and SEC-11 to SEC-16 record the security rules (amendment 0.17.0).

Spec: [machine peers](../specs/2026-10-28-machine-peers-design.md), sections 1 to 7, 9 and 10.
