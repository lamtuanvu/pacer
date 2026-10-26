# pacer user docs

pacer delegates coding work according to subscription usage and pace. Start with the [quickstart](../README.md#quickstart), then use:

- [Installation](install.md): source build, binary installer and planner setup.
- [Configuration](configuration.md): strategy files, providers, pacing and routing.
- [Executors](executors.md): CLI requirements, usage sources and execution placement.
- [Remote runners over SSH](remote-hosts.md): host setup, account folders, bundle transfer, local review and recovery.
- [CLI and skill](cli.md): structured briefs, task commands and JSON contracts.
- [Built-in terminal](terminal.md): workspace shells, tabs, splits, search and integrated app actions.
- [Client protocol 3.0](protocol.md): HTTP + SSE and JSON-RPC transports, errors, events and operation schemas.
- [Protocol 2.x overlap](protocol-v2.md): compatibility API, served for one more pacer minor release.
- [Desktop app](../desktop/README.md): the recommended way to install and set up pacer.
- [Live validation](testing/live-validation.md): sandbox service, real executors, surface checks and CT-11 evidence.

`pacer --help` lists commands. `pacer doctor` checks local setup. The [design spec](specs/2026-10-11-pacer-design.md) records architecture and historical design intent; use these user docs and CLI help for current behavior.
- [Distribution channels](distribution.md): GitHub Releases, install.sh, npm and Homebrew

- [Design system](../design/README.md): identity, tokens and standalone reference boards.
- [Roadmap](../ROADMAP.md): launch intentions.
