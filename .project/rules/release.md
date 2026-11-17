# Release and distribution rules

Applies to: the `package.json` version, `CHANGELOG.md`, `scripts/release*`, `.github/workflows/release.yml`, `.github/workflows/release-prepare.yml`, `.github/workflows/desktop.yml`, `npm/**`, the Homebrew formula and the desktop app version.
Out of scope: day-to-day feature changes, apart from adding CHANGELOG Unreleased entries.
Owner: @lamtuanvu
Canonical sources: [CONTRIBUTING.md § Releasing](../../CONTRIBUTING.md), [docs/distribution.md](../../docs/distribution.md), `.github/workflows/release.yml`, [SECURITY.md](../../SECURITY.md)

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| REL-1 | Releases follow SemVer. CHANGELOG follows Keep a Changelog. During 0.x, breaking changes are documented in CHANGELOG. | Established | CHANGELOG.md; ROADMAP.md | Review |
| REL-2 | Release flow: the maintainer runs **Prepare release** on `main`. It pins one commit (main's head when the run starts, or a chosen `main` commit) and picks the version from commit titles since the last tag (or the chosen bump). A pinned commit whose `package.json` version is still untagged releases at that version. Otherwise `bun run release:prepare x.y.z` adds one `chore: release x.y.z` commit on top. The workflow tags that commit `vx.y.z` (annotated, matching `package.json`) and pushes only the tag; the tag runs `release.yml`, which builds, requires CI's full suite on both OSes for the tagged commit and publishes from the tag alone. Later merges to `main` never affect a tagged release. A bookkeeping PR brings the version bump to `main` afterwards; the release never waits for it. Tags are never moved; a failed release is fixed by rerunning `release.yml` on the tag, or with a new version. | Established (amended 0.21.0 proposed) | CONTRIBUTING.md; release-prepare.yml; release.yml verify job | CI release verify; test/release-automation.test.ts |
| REL-3 | Release builds cover darwin and linux on arm64 and x64, and each native binary gets a smoke test. They publish checksums and provenance attestations. | Established | release.yml | CI |
| REL-4 | Retired (0.5.0). Was: the `orca-plugin` branch and tag are pushed atomically. Plugin publishing is removed; existing `orca-plugin-v<ver>` tags are never moved or deleted. | Retired (0.5.0) | ADR retire-orca-plugin | — |
| REL-5 | Versions containing `-` are prereleases (npm dist-tag `next`). | Established | release.yml; docs/distribution.md | CI |
| REL-6 | Only the latest 0.x minor line is supported. | Established | SECURITY.md | n/a |
| REL-7 | Retired (0.5.0). Was: run the Orca e2e before a plugin release. There are no plugin releases. | Retired (0.5.0) | ADR retire-orca-plugin | — |
| REL-8 | The desktop app version tracks the package version (`release:prepare` bumps `desktop/src-tauri/Cargo.toml` and `tauri.conf.json`). Desktop artifacts ship unsigned and labeled `-unsigned` until Developer ID signing and notarization are set up (clients ADR D5). | Established | OD-5 decision, 2026-10-19; [desktop-first onboarding](../../docs/specs/2026-10-19-desktop-first-onboarding-design.md). The `release:prepare` bump is implemented for the desktop configuration, Cargo manifest and matching lockfile package entry (#188). | `release:prepare` diff; release review |

Relevant reviewers: [release](../reviewers/release.md)
Exceptions and open decisions: none. REL-8 was resolved by OD-5 on 2026-10-19; its `release:prepare` bump is implemented (#188).
