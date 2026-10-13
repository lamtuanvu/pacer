# Install pacer

Install the Orca marketplace plugin; it bootstraps pacer in the background.

In Orca Settings → Plugins, add `https://github.com/lamtuanvu/pacer.git`, then
install **pacer** (`lamtuanvu.pacer`) and grant its capabilities. The versioned
bundle is `https://github.com/lamtuanvu/pacer.git#orca-plugin-v0.1.18`.
The worker installs the binary, initializes `~/.pacer`, starts the login service,
and keeps older binaries updated to the plugin version. It never downgrades.

The marketplace panel is a static **Set up pacer** page. Wait for the ready
notification. The worker runs `pacer plugin install` itself once per plugin
version to prepare `~/.pacer/orca-plugin`.

In Orca Settings > Plugins:

1. Uninstall the marketplace pacer.
2. Under **Development**, add the absolute folder shown in the notification
   (normally `~/.pacer/orca-plugin`).
3. Enable pacer.

Orca only refreshes plugin panels added as a development folder, so the live
budget panel runs from there: [Orca #26951](https://github.com/stablyai/orca/issues/26951).
The marketplace worker never changes its integrity-checked folder. Progress
notifications persist across restarts. Bootstrap mode creates no terminals or
consoles. Agent configs still require a click.
`pacer plugin status` reports both marketplace and development copies. pacer
never edits Orca settings to add the development folder.

In the development panel, the live checklist shows **Install pacer**, **Start pacer**, and **Connect your
agents**. Connecting is your consent to modify the displayed skills, rules and
hooks in detected agent configs. The worker never edits those configs by itself.
The button runs `pacer setup --yes`; no MCP servers are added. Afterwards the
manifest shows connected agents. Use `pacer uninstall <agent>` to undo one.

Set **releaseBase** in the plugin's own settings while GitHub releases are
unpublished, or for a private release folder. It accepts HTTPS, `file://`, or
HTTP on `127.0.0.1`/`localhost`. Environment fallback: `PACER_RELEASE_BASE`.
The layout is `latest.json`, `<version>/SHA256SUMS`, and
`<version>/pacer-<os>-<arch>`. Every download is checksum verified. A 404 sends
an unpublished notification in bootstrap mode and retries after ten minutes; other failures get bounded
60-second retries. **Try again** refreshes the panel; the worker owns retry timing.

For a CLI-only installation or manual fallback:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
pacer setup
```

`pacer setup` previews changes and asks y/N in a TTY. Use `--yes` for unattended
setup, `--agents claude-code,codex` to select agents, and `--json` for a summary.
Non-TTY setup without `--yes` prints the plan and exits 2 without changes.


## Updating

For marketplace installs, open **Settings > Plugins > Refresh**, then choose
**Update plugin** on pacer. Orca does not refresh marketplace sources or update
plugins automatically; **Update plugin** appears after Refresh finds a newer version.

For development-folder installs, `pacer update` refreshes the managed plugin
folder. Turn pacer off and on in **Orca Settings > Plugins** to load it.

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
pacer install claude-code
pacer doctor
pacer status --json
```

`init` detects tools and requires a supported planner plus at least one executor. It refuses to overwrite an existing strategy unless passed `--force`. Planner choices are `claude-code`, `codex`, `cursor` and `opencode`.

`install` adds the pacer skill and planner policy/hooks with tracked backups. MCP is optional: use `pacer install claude-code --mcp` to register the stdio server, or `--no-mcp` to remove an existing entry. A plain reinstall leaves an existing MCP entry unchanged. Restart an MCP client after updating. `pacer uninstall <planner>` reverses the integration while preserving later user edits.

For local Orca development, run `pacer plugin install` and add the printed managed directory in Settings > Plugins; see the [plugin guide](../orca-plugin/README.md). `pacer serve` runs the loopback service. `pacer service install` manages it through launchd on macOS or a user systemd service on Linux; inspect with `pacer service status` and remove with `pacer service uninstall`.
