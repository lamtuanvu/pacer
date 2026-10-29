# Machine identity

Each pacer home has a **machine identity**, created the first time the service starts. It lets pacer and its plugins tell records and requests from different machines apart.

- The **machine id** is the base32-encoded public half of an ed25519 key pair. It stays the same until you rotate the key.
- The **machine name** is a display label. Until you set one it is `pacer-` plus four random characters, so your host name is never used by default. Names never identify a machine; two machines may share one.

## Commands

```sh
pacer machine show            # name, id and revision
pacer machine rename "Studio Mac"
pacer machine rotate --yes    # replace the key, and with it the machine id
```

Add `--json` for machine-readable output. The same actions are available to clients as the `machine.get`, `machine.set {name, expect_rev}` and `machine.rotate` operations ([protocol](protocol.md)). `machine.set` fails with `conflict` when `expect_rev` is stale, for example when another client renamed the machine first; read again and retry. Executor sessions can read the identity but cannot rename or rotate it.

Rotation asks for `--yes` because it replaces the machine id. Paired machines that cannot be told have to pair again. Rotation also invalidates every transport key that plugins had certified.

### The signed rotation statement

Before it replaces anything, pacer signs the change with the old key, as plugin id `pacer` with purpose `rotate`:

```text
"pacer-machine-sig/v1" 0x00 "pacer" 0x00 "rotate" 0x00 oldId 0x00 newId
```

Both ids are the ASCII base32 machine ids. A verifier checks the signature with the public key that `oldId` encodes. pacer keeps the statement in `machine.json` and returns it from `machine.get` (and `pacer machine show --json`) as `rotatedFrom` and `rotationSignature` (base64). It also publishes it to clients once, as a `machine` entity event with the value `{ event: "rotated", oldId, newId, signature }` (v3 only; see [protocol](protocol.md#events)). The machine peers design calls this event `machine.rotated`.

Plugins cannot receive the rotation yet: pacer does not forward host events to plugins. Delivering it to plugins, so they can tell paired machines, is deferred to the peer transport work. Until then a client can read the statement from `machine.get`.

Rotation is crash-safe. pacer records the pending rotation in `machine.json` and stores the new key under a staging item (`machine-identity-staging/<homeTag>` in the Keychain, or `identity/machine.key.staging`) before it replaces the current key. If pacer stops part way, the next start finishes the rotation when the new key was stored, or rolls it back when it was not. A rotation that fails, for example because the Keychain refused the update, changes nothing and announces nothing.

## Where the key is stored

| Platform | Private key | Install salt |
| --- | --- | --- |
| macOS | login Keychain, service `pacer`, account `machine-identity/<homeTag>` | login Keychain, service `pacer`, account `machine-install-salt/<homeTag>` |
| Other | `$PACER_HOME/identity/machine.key` (mode 0600, directory 0700) | `$XDG_STATE_HOME/pacer/install-salt/<homeTag>` (`~/.local/state` when `XDG_STATE_HOME` is unset) |

`<homeTag>` is the first 16 hex characters of the SHA-256 of `pacer-home/v1`, a zero byte and the real path of `PACER_HOME`. Each pacer home on one machine therefore has its own Keychain items and salt, and a test or sandbox home never shares or overwrites the identity of your main home. The public id, name and revision live in `$PACER_HOME/identity/`.

The private key is never returned by an operation, event or log.

## "This home looks copied"

When pacer creates an identity it also records an install salt outside `$PACER_HOME` (see the table). Both the private key and the salt are tied to the path of the home, so a home copied to another path or machine finds neither under its own tag. The home was then most likely copied: restored from a backup, synced between machines with dotfiles, or part of a cloned VM, and two machines could share one id.

When pacer loads an identity and finds `machine.json` but the private key is missing, or the salt is missing or different, it records the copy in `machine.json` (`cloneDetected`) before it changes anything. If the key is missing, pacer then creates a new key and salt so the machine keeps working, keeping the name and raising the revision. The record stays until you rotate. `pacer machine show` reports it (`cloneSuspected: true` in JSON) and says:

```text
This home looks copied from another machine. Run pacer machine rotate --yes to give it its own identity.
```

Until then plugins cannot sign with the machine key (see [Plugin signatures](#plugin-signatures)). Run `pacer machine rotate --yes` on the copy. If you moved a home on purpose and no other machine still uses the old copy, rotating is still the simplest way to clear the warning.

## Machine id in records

Activity entries and task records carry the `machineId` of the machine that wrote them, so records from several machines can be told apart. The id is a stable device identifier. Redact it before posting logs, task exports or screenshots publicly.

## Plugin signatures

A plugin granted the `identity.sign` capability can ask pacer to sign a payload with the machine key, but only for the purposes it declares in its manifest. pacer never signs raw bytes: it signs

```text
"pacer-machine-sig/v1" 0x00 plugin_id 0x00 purpose 0x00 payload
```

so a signature made for one plugin and purpose cannot be reused as another's. The plugin id `pacer` is reserved for pacer's own signatures. See [plugin protocol](plugin-protocol.md#capabilityidentitysign) for the request format.

Every signature, including pacer's own rotation signature, and every refused signing request is recorded in `$PACER_HOME/logs/identity-audit.jsonl` (mode 0600, directory 0700). Each line is a JSON object with the time (`at`, Unix seconds), `pluginId`, `purpose`, `sha256` of the payload, `outcome` (`signed` or `refused`), the `reason` for a refusal and the signing `machineId`. The payload itself is never recorded. pacer only appends to this file, and plugins cannot write to it: `capability.log` writes to the plugin's own log under `logs/plugins/`.

While the home looks copied (`cloneSuspected`), pacer refuses every `identity.sign` request with `capability_denied` and tells the user to run `pacer machine rotate --yes`. A copied home on the file backend still holds the source machine's private key, so a signature from it could be taken for the other machine's. Rotation gives the home its own key and signing works again.
