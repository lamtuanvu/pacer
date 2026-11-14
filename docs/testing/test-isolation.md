# Test isolation

Run `bun run test` from the checkout, optionally followed by test paths or Bun
flags. The command pins the test timezone and, on macOS, starts the suite under
`sandbox-exec` with outbound TCP to loopback ports 4317, 11434, 1234 and 41343 denied. The sandbox is
inherited by descendants, including plugin processes with sealed environments.
It performs a loopback self-check on a disposable port before starting. On other
platforms the command runs Bun directly.

The preload also isolates HOME and PACER_HOME, selects non-default service ports, and redirects Ollama and LM Studio setup probes to closed ports;
child environments that do not inherit it use `test/child-env.ts`. Tests that run
their own server pass its port explicitly. Use the wrapper for local testing:
`bun test` bypasses the operating-system sandbox. The macOS wrapper signs a
non-setuid temporary copy of `ps` because macOS refuses to execute its setuid
system copy inside a sandbox; the copy is removed when the test run exits.
