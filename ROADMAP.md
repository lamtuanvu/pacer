# Roadmap

These are intentions, not commitments. Current behavior is documented in the [user docs](docs/README.md).

## Now (pre-1.0)

- Finish the Rust M1 release gate: artifact parity/conformance, signed bridge-to-paired desktop upgrade and recovery, distribution validation, current-head CT-11 evidence, and the maintainer’s release decision. M1 remains pending while required gates are FAIL or UNVERIFIED.
- Prepare M2 core ports against the existing API and persistence contracts, reconciling current plugin extraction prerequisites before moving runtime ownership.

- Cut the first public release and verify the binary installer on a clean machine.
- Wire npm publishing and Homebrew formula updates into `release.yml`, using the existing release scripts.

## Later

- Stabilize the strategy configuration and MCP contracts before 1.0; document breaking changes during 0.x.
- Add a docs site if demand warrants it; until then the repository docs are authoritative.
