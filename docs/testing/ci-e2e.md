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
contract. Chromium and WebKit each navigate from `localhost` to the sign-in URL on
`127.0.0.1`, without preloading cookies or bearer headers. They check the first app
document, Strict/HttpOnly cookie attributes, single-use code redemption, reload,
and cookie-authenticated API access. Delegation through that browser session runs
`test/fixtures/bin/fake-agent` in completion mode and must produce a completed task
in the review queue. The service, browser and any unfinished task are stopped.

The disposable fixture intentionally leaves service/planner integration incomplete.
Before reloading, the browser test waits for the resulting setup route and its
required-steps region. This prevents the asynchronous setup redirect from canceling
WebKit's reload; the test still requires an HTTP 200 reload and cookie-authenticated
API access afterward.

The unit suite skips these tests unless `PACER_E2E=1`. Missing builds or browsers
fail the explicit e2e command. This CI test does not build or drive the native
Tauri shell, install a launch agent, or verify native desktop process replacement
after reinstall; those surfaces still require desktop validation. Fake delegation
does not replace CT-11 live validation for runtime changes.
