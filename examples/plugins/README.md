# Bundled plugin sources (SDK examples)

These directories are the original TypeScript implementations of pacer's bundled
plugins. They are **SDK examples, not shipped code**: the product serves each
plugin from the native Rust table in `crates/bundled/src/lib.rs`, and each native
implementation lives in `plugins-rs/<id>/`.

They stay in the tree as the parity reference for `test/plugin-parity/` until
D3 removes the TypeScript core. Do not change their behavior as part of the
move from `plugins/`; only the native ports change behavior.

Run one against a scripted host over stdio:

```
bun examples/plugins/run.ts <id>
```

`<id>` is any of the twelve bundled plugin ids (`pacer-planners`,
`pacer-endpoints`, `pacer-notify`, `pacer-classify`, `pacer-usage`,
`pacer-agent-session`, `pacer-assistant`, `assistant-executor`, `pacer-ssh`,
`pacer-remote-caller`, `pacer-exec-direct`, `pacer-exec-orca`). An unknown id
prints `pacer: no bundled plugin <id>` and exits 2.

`pacer-dev` is also accepted by the runner: it is a bundled workflow plugin
from the workflow-frame workstream that has no Rust port yet and is out of
scope for C13. `pacer-policy-budget` is a policy example, not a bundled plugin;
it has no `plugins-rs/` counterpart and is not runnable through this runner.
