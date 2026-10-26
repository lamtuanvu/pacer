# Strategy parse and validation oracle

The 16 synthetic `cases.json` entries exercise `Bun.YAML.parse` followed by TypeScript `validateStrategy`. `scripts/golden/strategy-load.ts` records the complete normalized strategy object or ordered validation problems in `goldens.json`. All logical paths use the literal `$HOME/strategy.yaml`; no user strategy or credentials are read.

Run `bun scripts/golden/strategy-load.ts --check` to verify the checked-in oracle. Regenerate without `--check` only after an intentional TypeScript behavior change, then inspect the full diff. Rust comparisons treat the normalized JSON object semantically, while StrategyError problems and messages are ordered text.

This corpus does not yet cover active-file path selection, `MissingStrategyError`, migration writes, locks, activity/outbox publication or all strategy schema branches. The Rust basic read-model subset currently selects five valid current-account cases and returns `None` for the other eleven; none of those cases is routed to a public operation.
