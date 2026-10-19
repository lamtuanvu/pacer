# Install pacer

Install the Orca marketplace plugin; it bootstraps pacer in the background.

In Orca Settings → Plugins, add `https://github.com/lamtuanvu/pacer.git`, then
install **pacer** (`lamtuanvu.pacer`) and grant its capabilities. The versioned
bundle is `https://github.com/lamtuanvu/pacer.git#orca-plugin-v0.1.24`.
The worker installs a checksum-verified binary and keeps older binaries updated to
its version. It never downgrades. Once per Orca launch it opens a terminal titled
**pacer** in the focused worktree: `pacer init` if strategy or login service setup
is missing, otherwise `pacer dashboard`. If nothing is focused, it checks again
every 30 seconds without reserving a terminal. Closing the tab does not reopen it;
run `pacer init` or `pacer dashboard` manually.

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
5. If Orca is installed, prepare `~/.pacer/orca-plugin`. Add that folder in Orca
   **Settings > Plugins > Development > Add folder**, then enable pacer. Init
   prints the path, copies it on macOS when pbcopy is available, and waits up to
   five minutes for the live heartbeat. Enter or Ctrl-C skips this wait; finish
   later with `pacer init`.
6. Print a summary and open the dashboard in an interactive terminal, unless
   `--no-dashboard` is supplied.

Rerunning init skips completed steps. `--yes` consents to all detected agents;
`--agents claude-code,codex` limits agent selection. Non-TTY runs do not prompt,
wait or open a dashboard; they set up strategy/service, and connect agents only
with `--yes` or `--agents`. `--json` returns a machine summary without prompts.
`pacer setup` remains an alias of `pacer init`.

Only development-folder panels refresh live. Once that panel is running, the
marketplace worker becomes dormant and sends one notification per version:
“pacer now runs from its live panel. You can uninstall the marketplace copy in
Orca Settings > Plugins.” Pacer never edits Orca settings or disables a plugin.
`pacer plugin status` reports both copies. Undo an agent with
`pacer uninstall <agent>`.

Set **releaseBase** in the plugin settings for a private or unpublished release
folder. It accepts HTTPS, `file://`, or HTTP on `127.0.0.1`/`localhost`, with
`PACER_RELEASE_BASE` as fallback. The layout is `latest.json`,
`<version>/SHA256SUMS`, and `<version>/pacer-<os>-<arch>`. Failures show a manual
`pacer init` command and use bounded retries. Before a plugin release, run the
[real-Orca harness](testing/orca-e2e.md).

For a CLI-only installation or manual fallback:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
pacer init
```


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

## Binary installer

Install from [GitHub Releases](https://github.com/lamtuanvu/pacer/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
```

This works once the repository is public and the first release exists. [install.sh](../install.sh) and `pacer update` default to GitHub: `releases/latest/download/latest.json` selects the version, and `releases/download/v<version>/<file>` serves its assets. Downloads follow at most five redirects, each to HTTPS.

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

For local Orca development, run `pacer plugin install` and add the printed managed directory in Settings > Plugins; see the [plugin guide](../orca-plugin/README.md). `pacer serve` runs the loopback service. `pacer service install` manages it through launchd on macOS or a user systemd service on Linux; inspect with `pacer service status` and remove with `pacer service uninstall`.

On standalone `pacer serve` startup, managed plugin assets are compared with the
bundled assets by content hash. Unchanged assets need no refresh, even when the
service and plugin versions differ. When assets change, the service repairs them
and adds one reload reminder in Needs you. Turn pacer off and on in Orca Settings
> Plugins, then dismiss the reminder with Done. Dismissal survives service restarts.
Orca currently exposes no plugin reload API or CLI command.

Update availability is checked on plugin startup and every six hours, with one
notification per new version. Marketplace: Orca Settings > Plugins > Refresh,
then Update plugin. Development folder: use the live panel's Updates card or
`pacer update`, then turn pacer off and on in Orca Settings > Plugins; if only the
plugin is behind the CLI, run `pacer plugin install` first. `pacer update --check
--json` reports versions without installing. Disable checks with
`PACER_NO_UPDATE_CHECK=1` or top-level `update_check: false` in the active strategy.
Checks only GET `latest.json`, time out after three seconds, and cache in
`~/.pacer/update-check.json`; CLI cache reuse lasts 24 hours. The static marketplace
panel has no update buttons or host calls, and the worker never installs a newer
release than the version shipped with its plugin.

## Desktop app updates on macOS

Replace the installed `pacer.app` bundle with the new version at the same path.
The running app checks its executable and bundle version every 30 seconds and
restarts itself from the replacement bundle after a short delay. It keeps the
main window's visibility and route, and the tray reconnects to the service to
restore its status. Update the pacer CLI separately. See
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
