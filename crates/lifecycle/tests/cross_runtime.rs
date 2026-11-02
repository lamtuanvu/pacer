#![allow(clippy::unwrap_used)]

/// Cargo builds the disposable driver and always runs the mixed-runtime races,
/// including in CI; no optional environment flag can silently skip coverage.
#[test]
fn bun_and_rust_share_admission_revisions_descendant_budgets_and_slots() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("bun")
        .args(["run", "test", "test/tasks-rust-admission-parity.test.ts"])
        .env(
            "PACER_ADMISSION_PROBE_BIN",
            env!("CARGO_BIN_EXE_task_admission_probe"),
        )
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
