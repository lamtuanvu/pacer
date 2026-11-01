# Strategy read parity goldens

`cases.json` contains input values and normalized results or ordered validation
problems from TypeScript `validateStrategy` in `src/config/strategy.ts`.
`migrations.json` contains byte-exact before/after YAML from TypeScript
`migrateStrategy` in `src/config/migrate.ts`; the final case is the starter from
`test/config-migrate.test.ts`. `named.json` contains `list`, `show`, and active
`loadStrategy` results from an isolated home using the TypeScript functions.

The Rust tests in `crates/config/tests/strategy_parity.rs` replay these inputs
and compare full JSON values and YAML bytes. Update goldens from the TypeScript
implementation before changing the Rust behavior (RUST-7).
