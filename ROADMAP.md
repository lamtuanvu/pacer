# Roadmap

These are intentions, not commitments. Current behavior is documented in the [user docs](docs/README.md) and [Orca limitations](orca-plugin/README.md#known-limitations-orca-pluginapi-1-verified-on-orca-14224).

## Now (pre-1.0)

- Cut the first public release and verify the binary installer on a clean machine.
- Wire npm publishing and Homebrew formula updates into `release.yml`, using the existing release scripts.
- Make the plugin available through the Orca marketplace listing.

## When Orca ships…

| Upstream API | What pacer changes |
| --- | --- |
| [Panel → worker messaging (#25129)](https://github.com/stablyai/orca/issues/25129#issuecomment-6126817756) | Send actions directly to the worker; remove the console-per-worktree requirement and auto-open service path. |
| [Plugin terminal creation and cross-worktree typing (#28008)](https://github.com/stablyai/orca/issues/28008) | Let the plugin open its helper terminal itself, removing the external service's terminal-opening role. Plugin-owned terminals could be reused across worktrees. |
| [Worker → panel push (#26951)](https://github.com/stablyai/orca/issues/26951#issuecomment-6126818405), related [#15638](https://github.com/stablyai/orca/issues/15638) | Provide live budgets for installed plugins and drop development-path HTML rewrites. |
| [Panel allow-forms (#28009)](https://github.com/stablyai/orca/issues/28009) | No user-visible change needed: existing buttons already work. Native submit handling could simplify the implementation. |
| [Exec / declared commands (#18214)](https://github.com/stablyai/orca/issues/18214#issuecomment-6126819013) | Run panel actions through a declared pacer command without depending on a terminal in the active worktree. |

These APIs overlap; adopt the smallest supported path rather than maintaining every workaround indefinitely.

## Later

- Stabilize the strategy configuration and MCP contracts before 1.0; document breaking changes during 0.x.
- Evaluate the future CLI-to-plugin message transport already probed by the plugin when Orca exposes a channel.
- Add a docs site if demand warrants it; until then the repository docs are authoritative.
