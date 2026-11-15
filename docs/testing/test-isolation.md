# Test isolation

Run `bun run test` from the checkout, optionally followed by test paths or Bun
flags. It pins the test timezone, and the preload (`test/setup.ts`) isolates
`HOME` and `PACER_HOME`, pins `PACER_PORT` to a closed loopback port, and
redirects the Ollama (`OLLAMA_HOST`) and LM Studio (`LMS_API_SERVER_INFO_PATH`)
setup probes to closed ports. So no spawned pacer process can reach the
maintainer's running service on 4317 or a local model server. Child
environments that do not inherit the preload's environment use
`test/child-env.ts` (`childEnv`, `pinnedEnv`, `closedPort`). Tests that run
their own server pass its port explicitly.

On macOS, `bun run test:sandbox` additionally runs the suite under
`sandbox-exec` (`scripts/test-sandbox.ts`), with outbound TCP to loopback
ports 4317, 11434, 1234 and 41343 and `launchctl` denied. The sandbox is
inherited by descendants, including plugin processes with sealed environments,
and it self-checks on a disposable port before starting. macOS refuses to run
its setuid `ps` inside a sandbox, so the wrapper puts a signed non-setuid copy
first on `PATH` and in `PACER_TEST_PS`. Remote-host fixtures whose login shell
resets `PATH` still reach `/bin/ps`, so some remote stop tests fail under the
sandbox on recent macOS. That's why the sandbox is opt-in, not the default.
