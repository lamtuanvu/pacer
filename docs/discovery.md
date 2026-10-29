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

The whole record is at most 400 bytes. It never contains the machine id, the OS user name or the host name; the record's host is the discovery id. The record's address is the interface's IPv4 address, the one other machines on the link already see; no IPv6 address is published. The default machine name, `pacer-` plus four random characters, keeps the host name out; rename the machine if you want something easier to recognize.

Every pacer with discovery on listens, including on networks it is not advertised on, so it can show you the machines it finds. It listens and advertises only on the interface of the default route (for example `en0` or `wlp2s0`), never on VPN tunnels, container bridges or other interfaces, and it ignores answers heard on any other interface. When the default route moves to another interface, discovery moves with it.

Discovery stays on the local network link. pacer runs its own small mDNS responder, which uses IPv4 only in this version: it does not advertise or listen over IPv6. It ignores every packet whose source address is outside the interface's IPv4 subnet or the link-local range 169.254.0.0/16. It answers only multicast queries sent from port 5353 and sends its answers to the mDNS multicast group, never back to the sender, so a host off the link gets no reply and its announcements are dropped. On Linux its socket is bound to the mDNS group address itself, so it receives only packets sent to that group, which routers never forward off the link. On macOS it is bound to the wildcard address, because macOS cannot send from a socket bound to the group; with that socket open, unicast mDNS queries to the Mac were all answered by mDNSResponder and none reached pacer. Either way unicast mDNS packets stay with the system's own responder (mDNSResponder or Avahi), so pacer does not get in the way of printers, AirPlay or other `.local` names. If sending fails, pacer logs the first failure and the recovery. When the interface has several IPv4 addresses, pacer uses the one on the default gateway's subnet.

## Ask once per network

pacer recognizes a network by its router and, on Wi-Fi, its name (SSID); it stores only a hash of the two. On macOS the router is identified by its IPv6 link-local address, which needs no Local Network permission: the default IPv6 router's when there is one, otherwise the source of the router advertisement shown for the interface, and the default gateway's hardware address only when there is no advertisement. Mesh nodes and smart-home border routers also send advertisements, so the default router is preferred. On Linux it is the default gateway's hardware address. When the default route is on a wireless interface and the SSID cannot be read (NetworkManager's `nmcli` is installed but does not report it on Linux, or `ipconfig getsummary` fails on the Wi-Fi port on macOS), pacer treats that check as incomplete rather than as a network without an SSID: it keeps the last network it saw with the same router, or treats the network as unknown if it has none, so a brief lookup failure never creates a second network entry.

The router identity can still change, for example when a mesh network moves the default router to another node. On Wi-Fi, pacer also keeps a hash of the gateway's IPv4 address and the SSID with each network it knows. When a new router identity shows up with the same gateway address and SSID, pacer treats it as the same network and keeps your answer only if this pacer process saw the known network within the last 10 minutes and both identities are of the same kind (two router advertisements, or two gateway hardware addresses). Otherwise it is a new network that pacer asks about, with its own discovery id: many unrelated networks share a common SSID and a default gateway such as 192.168.1.1, and a copy of your home network's name elsewhere must not get your answer or your id. The cost is that pacer asks again when the identity changes while it was not running, or changes kind, for example when the router advertisement arrives a few seconds after joining a network first identified by its gateway's hardware address. Networks without an SSID are matched only by their router identity, because many unrelated wired networks share a gateway address. The first time pacer sees a network it asks once: **Let your other machines find this one on {network}?**, showing the exact name it will advertise, with **Allow** and **Not on this network**. Nothing is advertised until you choose Allow. When pacer cannot identify the network, for example on a VPN-only connection, it neither listens nor advertises there and does not ask.

To identify the network pacer runs the system's own tools by absolute path, so a service started without `/sbin` on its `PATH` still finds them: `/sbin/route` (for the IPv4 and IPv6 default routes), `/usr/sbin/ipconfig`, without a router advertisement `/usr/sbin/arp`, and, when `ipconfig` fails, `/usr/sbin/networksetup` (to tell whether the interface is the Wi-Fi port) on macOS; `ip` from `/usr/sbin`, `/sbin`, `/usr/bin` or `/bin` and `/usr/bin/nmcli` on Linux.

To change an answer later:

- In the app, open **Settings › Machines › Discovery**. Each network you answered has **Allow** or **Stop**, and **Reset id**, which gives this machine a new discovery id on that network so machines there no longer recognize the old one.
- From the CLI, `pacer discovery network` lists the networks you answered (the current one is marked `*`) and `pacer discovery network --advertise on|off` changes the current one. See [CLI](cli.md#discovery).

## Found machines

When pacer sees another pacer on the network, it shows **Found pacer on {name}** in Needs you, in the app's notice and as a desktop notification:

- **Pair** hands the machine to a pairing plugin (see below).
- **Later** silences that machine for 7 days.
- **Not mine** silences it permanently.
- **Stop on this network** mutes all found-machine prompts on that network.

The app's notice and `pacer discovery pair|later|ignore|mute-network` offer all four. Needs you and desktop notifications offer Pair and Later, and Linux notifications have no buttons. Limits keep the prompts quiet:

- A machine is offered once per silence period: when it is first seen, and again only if it is still being seen after its last prompt is 7 days old and it is not silenced, for example once a Later has expired. Its prompt stays open for up to 7 days, until you answer it. A machine that was not offered because of the hourly limit is offered the next time it is seen. A machine still on the network is seen again about every 10 minutes.
- At most 3 prompts are raised per hour in total, however many machines appear.
- A muted network raises none.
- When a pairing plugin accepts Pair, the prompt closes everywhere: in Needs you, in the app's notice and in notifications. pacer records the hand-over, so the machine is offered again only after another 7 days of being seen, like after a Later. When no plugin accepts it, the prompt stays open.

`pacer discovery ls` lists the machines seen, most recent first, with silenced ones marked. Anyone on the link can announce many made-up machines, so pacer keeps about 256 of them, plus machines with an open prompt or a silence, forgets a machine not seen for 30 days and evicts the least recently seen first, keeping machines with an open prompt or a silence. `discovery.list` returns at most the 100 most recently seen.

### Names are unverified

Anyone on the network can announce any name. pacer shows discovered names as text marked **Unverified name**, never uses them to build a link or a command, and refers to a machine only by its discovery id. The prompt does not pair anything by itself: Pair only starts pairing, and the pairing plugin decides how to confirm that the machine is yours.

## Pairing needs a plugin

pacer itself does not pair machines. Pair calls `pairing.start` on the first enabled plugin that provides pairing and accepts it ([plugin protocol](plugin-protocol.md)); the app then says which plugin continues. Plugins are tried in turn within 10 seconds in total; a plugin that fails, times out or returns an invalid result is skipped and the reason is written to its plugin log. When no such plugin is installed and enabled, Pair in the app's notice, in Needs you, in the tray and in desktop notifications opens the **Pair machines** page, which says that pairing is provided by plugins and links to Plugins settings, and the CLI says that none is installed.

## Turn discovery off

`pacer discovery off`, or the **Find machines on this network** switch in Settings › Machines, stops both listening and advertising and closes the open prompts. `pacer discovery on` turns it back on; your per-network answers are kept. The switch belongs to this machine, not to the routing strategy: it is kept in `$PACER_HOME/discovery/state.json`, so it works on a fresh install before `pacer setup`. The API operation is `discovery.set { enabled }`. If that file exists but cannot be read, discovery stays off and `pacer discovery ls` and `discovery.list` say so (`warning`). Other changes are refused until you turn discovery on (or off) again, which starts over with a fresh file.

Discovery is part of client protocol 3 only. Protocol 2 clients get none of its operations, events, attention items or notifications, and their attention counts leave discovery items out.

## Where discovery runs

The network side runs in the `pacer` front door, which pulls what to advertise from the core and passes back what it hears; the core keeps all answers and limits in `$PACER_HOME/discovery/state.json`. When no front door is running, as with the development `bun src/cli.ts serve`, discovery is unavailable: the app says "Discovery isn't available in this mode" and `pacer discovery ls` says the service is not running its LAN radio.
