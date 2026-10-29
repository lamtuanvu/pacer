# LAN discovery

pacer machines on the same local network can notice each other and offer to pair. Discovery only tells you that another pacer is there. It sends no work, opens no connection and trusts nothing it hears: pairing itself comes from a plugin.

## What is advertised

A machine is advertised only on networks you allowed. Its record (mDNS service `_pacer._udp.local`, which stays on the local network link) carries:

| Key | Value |
| --- | --- |
| `id` | A random discovery id for this network, 26 base32 characters. Each network gets its own, so the same machine looks unrelated on two networks. |
| `name` | The [machine name](machine-identity.md), cleaned of control characters and cut to 64 bytes. |
| `v` | The pacer version. |
| `h` | Optional, opaque hints from an enabled pairing plugin, at most 200 bytes. |

The whole record is at most 400 bytes. It never contains the machine id, the OS user name or the host name; the record's host is the discovery id. The default machine name, `pacer-` plus four random characters, keeps the host name out; rename the machine if you want something easier to recognize.

Every pacer with discovery on listens, including on networks it is not advertised on, so it can show you the machines it finds. It listens and advertises only on the interface of the default route (for example `en0` or `wlp2s0`), never on VPN tunnels, container bridges or other interfaces, and it ignores answers heard on any other interface. When the default route moves to another interface, discovery moves with it.

## Ask once per network

pacer recognizes a network by its default gateway's hardware address and, on Wi-Fi, its name (SSID); it stores only a hash of the two. The first time pacer sees a network it asks once: **Let your other machines find this one on {network}?**, showing the exact name it will advertise, with **Allow** and **Not on this network**. Nothing is advertised until you choose Allow. When pacer cannot identify the network, for example on a VPN-only connection, it neither listens nor advertises there and does not ask.

To identify the network pacer runs the system's own tools by absolute path, so a service started without `/sbin` on its `PATH` still finds them: `/sbin/route`, `/usr/sbin/arp` and `/usr/sbin/ipconfig` on macOS; `ip` from `/usr/sbin`, `/sbin`, `/usr/bin` or `/bin` and `/usr/bin/nmcli` on Linux.

To change an answer later:

- In the app, open **Settings › Machines › Discovery**. Each network you answered has **Allow** or **Stop**, and **Reset id**, which gives this machine a new discovery id on that network so machines there no longer recognize the old one.
- From the CLI, `pacer discovery network` lists the networks you answered (the current one is marked `*`) and `pacer discovery network --advertise on|off` changes the current one. See [CLI](cli.md#discovery).

## Found machines

When pacer first sees another pacer on the network, it shows **Found pacer on {name}** in Needs you, in the app's notice and as a desktop notification:

- **Pair** hands the machine to a pairing plugin (see below).
- **Later** silences that machine for 7 days.
- **Not mine** silences it permanently.
- **Stop on this network** mutes all found-machine prompts on that network.

The app's notice and `pacer discovery pair|later|ignore|mute-network` offer all four. Needs you and desktop notifications offer Pair and Later, and Linux notifications have no buttons. Limits keep the prompts quiet:

- A machine is offered once, when it is first seen. Its prompt stays open for up to 7 days, until you answer it.
- At most 3 prompts are raised per hour in total, however many machines appear.
- A muted network raises none.

`pacer discovery ls` lists every machine seen, with silenced ones marked.

### Names are unverified

Anyone on the network can announce any name. pacer shows discovered names as text marked **Unverified name**, never uses them to build a link or a command, and refers to a machine only by its discovery id. The prompt does not pair anything by itself: Pair only starts pairing, and the pairing plugin decides how to confirm that the machine is yours.

## Pairing needs a plugin

pacer itself does not pair machines. Pair calls `pairing.start` on the first enabled plugin that provides pairing and accepts it ([plugin protocol](plugin-protocol.md)); the app then says which plugin continues. When no such plugin is installed and enabled, Pair in the app's notice opens the **Pair machines** page, which says that pairing is provided by plugins and links to Plugins settings, and the CLI says that none is installed.

## Turn discovery off

`pacer config set discovery off`, or the **Find machines on this network** switch in Settings › Machines, stops both listening and advertising and closes the open prompts. `pacer config set discovery on` turns it back on; your per-network answers are kept.

## Where discovery runs

The network side runs in the `pacer` front door, which pulls what to advertise from the core and passes back what it hears; the core keeps all answers and limits in `$PACER_HOME/discovery/state.json`. When no front door is running, as with the development `bun src/cli.ts serve`, discovery is unavailable: the app says "Discovery isn't available in this mode" and `pacer discovery ls` says the service is not running its LAN radio.
