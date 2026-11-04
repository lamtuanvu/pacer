# One recorded owner for the installation

Date: 2026-11-04

Status: Proposed. Accepted when the maintainer merges it.

Context: [ADR 0001](0001-desktop-ota.md), [ADR 0011](0011-desktop-service-takeover-reclaim.md), [ADR 0019](0019-service-build-reconciliation-boundaries.md), [desktop updates](../desktop-updates.md).

A pacer installation has four parts: the `pacer` command at `~/.local/bin/pacer`, the background service (`com.pacer.serve`), updates, and the hooks in connected agents. The CLI installer and the desktop app can each set these up. Neither records who did. The desktop infers ownership from executable identity, so any build it cannot verify looks foreign: a user's own CLI install, a Homebrew install, or a development build that an agent copied in. It then offers **Use the app's service**, **Keep mine** or **Review service replacement**, and rechecks every 30 seconds.

This failed in practice. A development session copied the desktop executable (`Contents/MacOS/pacer`) over `~/.local/bin/pacer`. The desktop executable has no CLI mode, so every `pacer statusline`, `pacer serve` and `pacer open --print` started another GUI instance. The service never started. The app relaunched itself into the foreground about once a second, and each time a development build replaced `/Applications/pacer.app`. The user could not work until the processes were killed by hand.

## Decision

**Whoever installed pacer owns the installation, and the owner is recorded.**

- **CLI-only install** (installer script, npm, Homebrew): the CLI owns the command, the service, updates and agent hooks. The desktop is not involved.
- **Desktop installed, fresh or over a CLI install:** first launch shows one consent screen. It says the app will manage the service, the `pacer` command and updates, and that settings, tasks and connected agents are kept. On consent the desktop becomes the owner of all four parts:
  - **Service:** it moves the registration to its bundled CLI, using the same data home.
  - **Command:** it moves the existing command to a `pacer.pre-app-*` backup and links `Contents/Resources/pacer`.
  - **Updates:** the app, service and CLI update together.
  - **Agents:** existing connections carry over and are refreshed on update. Connecting a new agent still asks per agent, because it writes another tool's configuration.

  If work is running, the takeover waits until it finishes, then completes without asking again. Declining is remembered. The desktop then runs attached to the CLI's service and does not prompt again. Settings offers the takeover later.
- **The owner is one record**, `$PACER_HOME/owner.json`, holding `owner` (`cli` or `desktop`), the owner's executable identity and the consent time. Both the CLI and the desktop read it, and only the owner writes it.
- **The owner repairs its own installation without asking.** If the recorded owner finds its service or command replaced, it restores them, because the consent already covers this. A non-owner never repairs, replaces or relaunches anything; it reports the mismatch once.
- **A non-owner CLI defers.** When the desktop owns the installation, `pacer update` and `pacer service install|uninstall` exit with a message to use the app. `--release-ownership` hands ownership back to the CLI.
- **Uninstalling the desktop hands ownership back.** It restores the `pacer.pre-app-*` command if there is one, registers the service from it and records `cli`. Otherwise it removes the service and the link. `pacer uninstall --all` stays the full removal.
- **Development and test builds never act as an owner.** They use their own `PACER_HOME`, the fixture bundle identifier (`dev.pacer.desktop.fixture`) and a separate port. They never write the user's `owner.json`, `/Applications/pacer.app` or `~/.local/bin/pacer`.

These invariants hold for every owner:

- The desktop executable never boots a GUI for a CLI command. A bare command (`pacer <command>`) forwards to the bundle's CLI, or fails when there is none.
- CLI discovery never selects a desktop executable. The desktop marks its executable with an embedded marker, and discovery skips any candidate that carries it.
- A relaunch the user did not ask for never takes focus (`open -n -g`).

## Consequences

The prompt variants collapse into one consent plus a recorded owner. ADR 0011's confirmation is still needed when no owner is recorded, but a recorded desktop owner no longer asks again for its own repairs. A development build copied into the user's paths gets repaired by the owner instead of looping. Development work therefore has to stay in its own `PACER_HOME`, or the owner and the build fight each other. The live and OTA harnesses must be checked against this rule.

This change ships the three invariants and the documentation fix. The owner record, CLI deference, uninstall handback and development isolation are follow-up work, tracked against this ADR.

## Alternatives considered

- **Keep inferring ownership from executable identity.** This cannot tell a user's own CLI from an agent's build. It is the cause of the prompt loops.
- **The desktop always overrides without consent.** This silently replaces a user's working CLI service and its update method.
- **The desktop never touches an existing install.** Users who install the app expect it to manage pacer. Attached mode stays available, but only as the declined path.
