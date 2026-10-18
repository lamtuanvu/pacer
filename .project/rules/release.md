# Release and distribution rules

Applies to: the `package.json` version, `CHANGELOG.md`, `scripts/release*`, `.github/workflows/release.yml`, `.github/workflows/desktop.yml`, `npm/**`, the Homebrew formula and the `orca-plugin` branch and tags, and the desktop app version.
Out of scope: day-to-day feature changes, apart from adding CHANGELOG Unreleased entries.
Owner: @lamtuanvu
Canonical sources: [CONTRIBUTING.md § Releasing](../../CONTRIBUTING.md), [docs/distribution.md](../../docs/distribution.md), `.github/workflows/release.yml`, [SECURITY.md](../../SECURITY.md)

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| REL-1 | Releases follow SemVer. CHANGELOG follows Keep a Changelog. During 0.x, breaking changes are documented in CHANGELOG. | Established | CHANGELOG.md; ROADMAP.md | Review |
| REL-2 | Release flow: `bun run release:prepare x.y.z`, then a PR titled `chore: release x.y.z`, then a dry-run dispatch, then a signed or annotated tag `vx.y.z` that matches `package.json`. | Established | CONTRIBUTING.md; release.yml verify job | CI release verify |
| REL-3 | Release builds cover darwin and linux on arm64 and x64, and each native binary gets a smoke test. They publish checksums and provenance attestations. | Established | release.yml | CI |
| REL-4 | The `orca-plugin` branch and `orca-plugin-v<ver>` tag are pushed atomically. An existing tag is never moved. | Established | release.yml | CI |
| REL-5 | Versions containing `-` are prereleases (npm dist-tag `next`). | Established | release.yml; docs/distribution.md | CI |
| REL-6 | Only the latest 0.x minor line is supported. | Established | SECURITY.md | n/a |
| REL-7 | Run the Orca e2e (docs/testing/orca-e2e.md) before a plugin release. | Established | docs/testing/orca-e2e.md | Manual report |
| REL-8 | The desktop app version tracks the package version (`release:prepare` bumps `desktop/src-tauri/Cargo.toml` and `tauri.conf.json`). Signing and notarization follow the clients ADR D5 once implemented. | Proposed | Desktop is 0.1.0 while the package is 0.2.3 | Pending decision |

Relevant reviewers: [release](../reviewers/release.md)
Exceptions and open decisions: REL-8.
