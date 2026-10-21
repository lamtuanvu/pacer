# Pacer updater patch

Vendored from crates.io `tauri-plugin-updater` 2.14.0, upstream revision
`44293a5722efcaf27060504e63b17aeba721b40f` (`plugins/updater`).
Registry archive SHA-256: `7259989d4fe11b2bf51f7d671642249b1837c4ae2da1430dc713ae38f98ceeec`.
Original Apache-2.0 and MIT licenses and source notices are retained.

## Delta

The `no-elevation` Cargo feature disables macOS administrator authorization after
an installation permission error. Enable it in every pacer dependency declaration,
including builds using `default-features = false`. The permission error then goes
through upstream cleanup, including preservation of a previous app that failed to
restore. No signature, extraction, atomic swap or rollback behavior is replaced.
The patch also preserves any remaining old backup when a different bundle occupies
the target: only a consumed backup proves rename restoration completed. This
cleanup correction applies independently of the feature. Other install paths
retain upstream behavior.

`pacer_permission_denied_never_requests_elevation` exercises a real filesystem
permission failure and counts attempted main-thread authorization callbacks. Its
callback never executes AppleScript, making the regression safe to run against
unpatched code. The original code failed with one callback; the patch passes with
zero and preserves the original error and target bytes.

Reproduce on macOS (using the repository Rust toolchain):

```sh
cargo +1.99.0 test --offline --manifest-path desktop/vendor/tauri-plugin-updater/Cargo.toml --no-default-features --features rustls-tls,no-elevation
```

The upstream test suite also covers fallback rename restoration and retained
backups. Native signed replacement and late permission changes are additionally
exercised by the disposable OTA harness. Product integration/live coverage is
required before enabling a production feed.

`pacer.patch` records the exact source/manifest delta for review and rebasing.
`Cargo.toml.orig` is upstream's original workspace manifest; builds use the
normalized `Cargo.toml`. Generated dependency lockfiles and targets are excluded.
Reassess the patch on every updater upgrade. Remove it only when an upstream
control provides the same guarantee and the regression still passes.
