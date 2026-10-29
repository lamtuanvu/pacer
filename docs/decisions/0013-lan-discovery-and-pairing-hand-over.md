# ADR 0013: LAN discovery and pairing hand-over

Status: Proposed, 2026-10-29

## Context

A user with pacer on several machines on one LAN has to find and pair them by hand. The host can notice other pacer installs and offer to pair them, but pairing itself belongs to a plugin (ADR 0012). Today the service listens only on loopback (SEC-3). Anything received from the LAN is controlled by whoever sends it.

## Decision

- **Presence only.** A new open module, `src/discovery/`, advertises and listens over mDNS (`_pacer._udp.local`), answers only link-local sources and bounds record sizes. It never opens a connection to anything it discovers.
- **Ask once per network.** Listening is on unless discovery is off. Advertising is on only on networks where the user said yes. The host asks once per new network, shows the exact name it will advertise and offers to change it. The answer is stored per network and can be changed in settings.
- **Random per-network id.** The advert carries a random discovery id per network, the machine name, the pacer version and opaque hints a pairing plugin may set. It never carries the machine id or the OS user name. The discovery id rotates when the network's answer is reset.
- **Untrusted values.** Discovered names are shown as unverified and sanitized. They are never used to build URLs or commands. Prompts are rate-limited and can be silenced per discovery id or per network. Only an interactive local client can answer a prompt.
- **Neutral pairing extension point.** A plugin that declares `contributes.pairing` receives **Pair** as a `pairing.start` call. The host keeps no list of plugin ids. When no plugin declares it, **Pair** opens a local page that explains machine pairing in neutral terms and says that pairing is provided by plugins. The page lists no plugins.
- **The host computes the SAS.** Pairing must use commit-then-reveal: both sides fix their machine id and certified transport key first, the initiator commits to its nonce and both identities and keys, and only then are nonces exchanged. Each plugin hands the transcript to its host. The host checks it, rejects reused nonces, checks its own slot and both transport-key certificates, recomputes the commitment and computes and renders a 6-digit SAS with the tiers being granted. Only after the user confirms on both machines does the host record the peer as confirmed, which minting a peer credential requires.
- **Off switch.** Discovery can be turned off in config and in settings.
- **Never blocks or degrades open features.** Discovery and pairing are additive. With discovery off, or with no pairing plugin, every open feature works as before.

## Consequences

- The open host gains its first non-loopback listener. SEC-11 limits it to presence-only mDNS, and SEC-16 treats everything discovered as untrusted (amendment 0.17.0).
- An attacker in the network path cannot grind a matching SAS by generating keys, because the commitment fixes both keys before any nonce is revealed. A plugin that lies to its host is outside the threat model.
- The open host may describe that plugins provide pairing, in neutral terms, without naming or recommending any.
- How a network is identified on wired or VPN links without a gateway MAC or SSID is still open.

Spec: [machine peers](../specs/2026-10-28-machine-peers-design.md), sections 8 and 10.
