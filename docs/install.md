# Installation

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

The npm name `@lamtuanvu/pacer` is reserved by project decision but is not published. The planned Homebrew tap `lamtuanvu/homebrew-tap` has not been created.

## Connect a planner

```sh
pacer init --planner claude-code
pacer install claude-code
pacer doctor
pacer status --json
```

`init` detects tools and requires a supported planner plus at least one executor. It refuses to overwrite an existing strategy unless passed `--force`. Planner choices are `claude-code`, `codex`, `cursor` and `opencode`.

`install` adds the pacer skill and planner policy/hooks with tracked backups. MCP is optional: use `pacer install claude-code --mcp` to register the stdio server, or `--no-mcp` to remove an existing entry. A plain reinstall leaves an existing MCP entry unchanged. Restart an MCP client after updating. `pacer uninstall <planner>` reverses the integration while preserving later user edits.

For Orca, run `pacer plugin install` and add the printed managed directory in Settings > Plugins; see the [plugin guide](../orca-plugin/README.md). `pacer serve` runs the loopback service. `pacer service install` manages it through launchd on macOS or a user systemd service on Linux; inspect with `pacer service status` and remove with `pacer service uninstall`.
