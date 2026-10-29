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

Rotation asks for `--yes` because it replaces the machine id. pacer announces the old and new ids in a `machine` entity event, signed by the old key, so plugins can tell paired machines. Paired machines that cannot be told have to pair again. Rotation also invalidates every transport key that plugins had certified.

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

Run `pacer machine rotate --yes` on the copy. If you moved a home on purpose and no other machine still uses the old copy, rotating is still the simplest way to clear the warning.

## Machine id in records

Activity entries and task records carry the `machineId` of the machine that wrote them, so records from several machines can be told apart. The id is a stable device identifier. Redact it before posting logs, task exports or screenshots publicly.

## Plugin signatures

A plugin granted the `identity.sign` capability can ask pacer to sign a payload with the machine key, but only for the purposes it declares in its manifest. pacer never signs raw bytes: it signs

```text
"pacer-machine-sig/v1" 0x00 plugin_id 0x00 purpose 0x00 payload
```

so a signature made for one plugin and purpose cannot be reused as another's. The plugin id `pacer` is reserved for pacer's own signatures. Every signature is recorded in the plugin's log with its purpose and the SHA-256 of the payload, never the payload itself. See [plugin protocol](plugin-protocol.md#capabilityidentitysign) for the request format.
