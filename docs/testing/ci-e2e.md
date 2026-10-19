# Install, sign-in and delegation in CI

The macOS `e2e` job in `.github/workflows/ci.yml` builds the CLI and runs
`test/install-signin-delegation.test.ts` against the compiled binary. Run locally:

```sh
bun install --frozen-lockfile
bun node_modules/playwright-core/cli.js install chromium webkit
bun run build
bun run test:e2e
```

The tests install and reinstall through `install.sh` using a local release fixture
and verified checksum, start the installed `pacer serve` with a temporary home and
free loopback port, and check that `open --print` satisfies the desktop auth URL
contract, including the app route fragment preserved through sign-in. Chromium
and WebKit each navigate from `localhost` to the sign-in URL on `127.0.0.1`, without preloading cookies or bearer headers. They check the first app
document, Strict/HttpOnly cookie attributes, single-use code redemption, reload,
and cookie-authenticated API access. Delegation through that browser session runs
`test/fixtures/bin/fake-agent` in completion mode and must produce a completed task
in the review queue. Its disposable home contains an empty Codex login indicator
(`.codex/auth.json`); the fake agent needs no credentials. Host Codex home and API
key overrides are removed so routing cannot depend on a developer's login. A unit
regression checks that this setup makes fake Codex eligible on a clean CI runner.
The service, browser and any unfinished task are stopped.

The unit suite skips these tests unless `PACER_E2E=1`. Missing builds or browsers
fail the explicit e2e command. This CI test does not build or drive the native
Tauri shell, install a launch agent, or verify native desktop process replacement
after reinstall; those surfaces still require desktop validation. Fake delegation
does not replace CT-11 live validation for runtime changes.
