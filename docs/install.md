# Install pacer

[Download pacer for Mac](https://github.com/lamtuanvu/pacer/releases/latest).
Choose `desktop-pacer-<version>-darwin-aarch64.app.tar.gz` for Apple silicon or
`desktop-pacer-<version>-darwin-x86_64.app.tar.gz` for Intel. Open the archive and
move `pacer.app` into Applications.

The app is signed with pacer's own certificate until pacer has an Apple Developer ID,
so macOS blocks the first launch. Open the app once, then choose **Open Anyway** in
System Settings › Privacy & Security (or run `xattr -dr com.apple.quarantine /Applications/pacer.app`).
This is needed once: the app updates itself afterwards from Settings › Updates.

The app includes the matching CLI. **Welcome** leads to one consent screen
listing the background service and the terminal link at `~/.local/bin/pacer`.
When `~/.local/bin` is missing from PATH, you can opt in to adding
`export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` for zsh or `~/.bashrc` for
bash. This checkbox is off by default; other shells get no automatic edit.
Continue to the step-by-step **Setup**: choose a planner, connect agents,
choose an executor and try a task. Install and sign in to the agents separately;
pacer does not handle their credentials.

If another pacer CLI is found, choose **Use the app's pacer** or **Keep mine**.
The app does not silently overwrite an existing terminal command.

Linux downloads are `pacer-<version>-linux-<x64|arm64>-unsigned.AppImage` and
`pacer-<version>-linux-<x64|arm64>-unsigned.deb` on the same release page.
Choose the matching architecture. Make the AppImage executable and launch it,
or install the `.deb` with `sudo apt install ./<downloaded-file>.deb` and run
`pacer-desktop`. Linux uses the same consent and Setup flow. See the
[desktop guide](../desktop/README.md#linux) for runtime dependencies.

## Terminal and servers

Install and sign in to your planner and at least one executor CLI first; the
[quickstart](../README.md#quickstart) has Claude Code and Codex commands. Then:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
pacer init
```

Init detects your tools, writes the strategy and connects agents after asking.
Discovery never runs IDE launchers such as `cursor` or `agy`; Cursor versions
come from `cursor-agent` when available. Local model discovery does not start
applications: Ollama and LM Studio must already be serving. LM Studio is queried
at its published API port (or its standard internal port, 41343). Otherwise the
tool is still detected by path, but its local model is left unset and can be
configured later.
Ask your planner for work in your repository — it delegates through pacer.
Use `pacer open` to watch and `pacer doctor` to check the installation. In the app, open **Settings → Diagnostics → Run checks** for the same results and suggested repairs. Checks do not change agent installations.

Diagnostics distinguishes **Configured** settings, **Tested working · fixture** handler behavior, and **Unverified** host invocation. The fixed Claude handler probes use isolated synthetic state; they never execute command strings from settings. They test Agent/Task denial, exploration/direct-edit allowance and session-context JSON. They do not prove that an installed command launches or that Claude fires it. Inspect `/hooks`, disabled hooks, project settings and launch overrides in the intended Claude account, then use a new session’s debug output to confirm invocation. The delegation guard covers Agent and Task subagents; normal direct edits are outside its scope. `PACER=off`, executor sessions, another selected planner, relaxed mode, unknown usage and no available executor can allow subagent calls.

The selected planner account determines the settings folder inspected. When another planner is selected, installed Claude integrations remain unverified with informational guidance to select the intended Claude account before checking its settings. A service `CLAUDE_CONFIG_DIR` mismatch is reported; the service cannot infer a separately launched Claude session’s environment. Preview a reconnect before repairing configuration, and use the named `claude-code#account` target when repairing a named account. Existing unrelated hooks remain owned by their original installer.

## Setup with pacer init

`pacer init` is the complete setup command. It runs these steps in order:

1. Detect planner CLIs and offer a numbered choice when several are installed.
   The default is your existing planner, otherwise the first detected. Use
   `--planner claude-code|codex|cursor|opencode` to choose directly. No agent CLI
   is required to create a valid starter strategy; the default is claude-code.
2. Create `~/.pacer/strategy.yaml` if missing. Changing planner updates only its
   planner line; existing strategy settings are preserved.
3. Install the login service if missing.
4. Show each unconnected agent's files and undo command, then ask y/N separately.
   No agent configuration changes without consent; no MCP servers are added.
5. Print a summary and open the dashboard in an interactive terminal, unless
   `--no-dashboard` is supplied.

Rerunning init skips completed steps. `--yes` consents to all detected agents;
`--agents claude-code,codex` limits agent selection. Non-TTY runs do not prompt
or open a dashboard; they set up strategy/service, and connect agents only
with `--yes` or `--agents`. `--json` returns a machine summary without prompts.
`pacer setup` remains an alias of `pacer init`. Undo an agent with
`pacer uninstall <agent>`.

## From source

Use Bun >=1.4.2 and a source checkout. Install/authenticate your planner and executor CLIs separately.

```sh
bun install --frozen-lockfile
bun run build
mkdir -p "$HOME/.local/bin"
cp dist/pacer "$HOME/.local/bin/pacer"
export PATH="$HOME/.local/bin:$PATH"
pacer --version
```

Without compiling, run `bun src/cli.ts --help` or replace `pacer` in examples with `bun src/cli.ts`. The compiled binary runs without Bun; development and the current source entry point require Bun.

To build the desktop app with that CLI, install the platform dependencies in
the [desktop guide](../desktop/README.md#build), then run from the repository root:

```sh
cd desktop
bun install --frozen-lockfile
./scripts/stage-cli.sh ../dist/pacer
CARGO_NET_OFFLINE=true bunx --no-install tauri build --bundles dmg --no-sign
# On Linux, use --bundles appimage,deb instead.
```

Offline builds require cached locked Rust dependencies. For a cross build,
stage a CLI compiled for the target with
`TAURI_TARGET_TRIPLE=<triple> ./scripts/stage-cli.sh <cli>` and pass the same
`--target <triple>` to the Tauri build.

## Binary installer

Install from [GitHub Releases](https://github.com/lamtuanvu/pacer/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
```

[install.sh](../install.sh) and `pacer update` default to GitHub: `releases/latest/download/latest.json` selects the version, and `releases/download/v<version>/<file>` serves its assets. Downloads follow at most five redirects, each to HTTPS.

Verify a downloaded binary's build provenance before running it:

```sh
gh attestation verify <file> -R lamtuanvu/pacer
```

`PACER_RELEASE_BASE` remains an override for another HTTPS or local `file://` release root; `pacer update --base <url>` overrides the environment. Explicit release roots keep this layout:

```text
latest.json
<version>/SHA256SUMS
<version>/pacer-darwin-arm64
<version>/pacer-darwin-x64
<version>/pacer-linux-arm64
<version>/pacer-linux-x64
```

Use a release root containing that layout. For locally built host artifacts:

```sh
bun run release:host
PACER_RELEASE_BASE="file://$PWD/dist/release" sh install.sh
```

The installer detects OS/CPU, verifies SHA-256 checksums, checks the staged binary version and installs to `$HOME/.local/bin`. `PACER_INSTALL_DIR` changes the destination; `PACER_INSTALL_VERSION` selects a version instead of reading `latest.json`. macOS and Linux support arm64/x64; musl-based Linux is not supported. Run `pacer update --check` to check for updates, or `pacer update` to install the latest release. `pacer update --to <version>` selects a specific release, including prereleases.

## npm and Homebrew

Once the channels are bootstrapped (see [distribution](distribution.md)), install with:

```sh
npm install -g @lamtuanvu/pacer
# Or:
brew install lamtuanvu/tap/pacer
```

For npm installs, update with `npm install -g @lamtuanvu/pacer@latest`; for Homebrew installs, use `brew upgrade pacer`. `pacer update` detects these install methods and exits with code 2 and the matching command instead of replacing a managed binary. `pacer update --check` still reports the available release and the same update hint.

## Connect a planner

```sh
pacer init --planner claude-code
pacer doctor
pacer status --json
```

`init` sets up all components with agent consent. Planner choices are `claude-code`, `codex`, `cursor` and `opencode`; a valid starter can be created before CLIs are installed.

`install` adds the pacer skill and planner policy/hooks with tracked backups. MCP is optional: use `pacer install claude-code --mcp` to register the stdio server, or `--no-mcp` to remove an existing entry. A plain reinstall leaves an existing MCP entry unchanged. Restart an MCP client after updating. `pacer uninstall <planner>` reverses the integration while preserving later user edits.

`pacer serve` runs the loopback service. `pacer service install` manages it through launchd on macOS or a user systemd service on Linux; inspect with `pacer service status` and remove with `pacer service uninstall`.

`pacer update --check --json` reports versions without installing. Disable checks with
`PACER_NO_UPDATE_CHECK=1` or top-level `update_check: false` in the active strategy.
Checks only GET `latest.json`, time out after three seconds, and cache in
`~/.pacer/update-check.json`; CLI cache reuse lasts 24 hours.
`PACER_RELEASE_BASE` selects a private or unpublished release folder (HTTPS,
`file://`, or HTTP on `127.0.0.1`/`localhost`) laid out as `latest.json`,
`<version>/SHA256SUMS` and `<version>/pacer-<os>-<arch>`.

## Pause delegation

Set `PACER=off` for a session (for example, `PACER=off claude`) to disable planner
pacing enforcement. Run `pacer pause <duration>` (for example, `pacer pause 1h`)
or choose **Pause 1h** in the tray menu to pause new delegation. Running tasks
continue. Use `pacer resume` to end the pause early.

## Uninstall

```sh
pacer uninstall --all
```

It lists everything it will remove (agent integrations, restoring their backups;
the login service; a leftover Orca plugin; `~/.pacer` or `PACER_HOME`), asks
once, then removes it. For an app install it also removes the app's terminal
link and only the marked PATH block it added, preserving other shell settings.
Move the app to the Trash afterward. Add `--binary` to delete a standalone pacer
binary too, and `--yes` to skip the question in scripts. To disconnect a single agent, use
`pacer uninstall <agent>`.

pacer no longer ships an Orca plugin. If an earlier version installed it, run
`pacer plugin uninstall` (or `pacer uninstall --all`), then remove pacer from
Orca Settings > Plugins.

## Desktop app updates on macOS

Replace the installed `pacer.app` bundle with the new version at the same path.
The running app checks its executable and bundle version every 30 seconds and
restarts itself from the replacement bundle after a short delay. It keeps the
main window's visibility and route, and the tray reconnects to the service to
restore its status. Replacing the app also updates its bundled CLI;
`pacer update` directs app installs to download the new app instead. If you chose
**Keep mine**, update that separate CLI through its original install method. See
[desktop build instructions](../desktop/README.md) for building the bundle.

## macOS: removable volumes

When repositories live on an external or removable volume, macOS may ask whether
pacer can access files on that volume. Allow the prompt once. If it was dismissed
or denied, open **System Settings > Privacy & Security > Files and Folders** and
allow **Removable Volumes** for pacer. Restart the service after changing access.

Bun's compiled binaries normally have an ad hoc signature. Its identity changes
with the binary contents, so rebuilding or updating can trigger the prompt again.
To keep a stable identity across local builds and downloaded updates, run once
from a source checkout:

```sh
bun scripts/sign-local.ts --create-identity
bun run build
```

The setup creates the self-signed **pacer local code signing** certificate and
private key in your login keychain, valid for ten years, and adds user trust for
code signing. It uses OpenSSL and macOS's `security` tools. macOS may request your
keychain password or a confirmation; approve that request and retry if the
bounded command times out. Setup reuses an existing identity. Keep that
certificate and private key: replacing them changes the signing identity.

Reinstall the resulting `dist/pacer` using the usual source-build instructions,
then run `pacer service install` to refresh the service. Builds and updates use
this identity with identifier `dev.pacer.cli` when available. Signing leaves
hardened runtime disabled so the compiled Bun runtime can execute. The release
builder signs macOS outputs when run on macOS with this identity; CI without it
keeps the usual ad hoc signature. Both `pacer update` and `install.sh` sign a
staged file before installation, preserving the running binary's inode.

Run `pacer doctor` to check registered repositories on removable volumes. It
probes each path in a child process with a three-second timeout. A timeout
suggests a pending permission prompt; an “Operation not permitted” result
indicates denied access. Doctor also reports an installed ad hoc signature and
the one-time identity setup command. Successful probes describe the current
process's access; repeat the check in the service's context if launchd access
still differs. Installing the stable identity does not approve the macOS access
prompt for you: the first signed build may still need permission once.
