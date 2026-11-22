#![allow(clippy::unwrap_used)]
use std::{fs, os::unix::fs::PermissionsExt, process::Command};

fn pacer() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_pacer"));
    c.env_remove("PACER_BIN").env_remove("PACER_CORE_ARGV");
    c
}

/// A fake core that echoes its argv and exits 7, passed through PACER_CORE_ARGV
/// so the front door execs it instead of a real pacer-core.
fn fake_core(dir: &tempfile::TempDir) -> String {
    let fake = dir.path().join("core.sh");
    fs::write(
        &fake,
        "#!/bin/sh\nprintf '%s|' \"$@\"; printf 'BIN=%s|' \"$PACER_BIN\"\nexit 7\n",
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    fake.to_string_lossy().into_owned()
}

fn expected_bin() -> String {
    fs::canonicalize(env!("CARGO_BIN_EXE_pacer"))
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[test]
fn plugin_run_runs_in_rust_and_hands_the_id_to_core() {
    let dir = tempfile::tempdir().unwrap();
    let mut cmd = pacer();
    cmd.env(
        "PACER_CORE_ARGV",
        serde_json::to_string(&[fake_core(&dir), "prefix".to_string()]).unwrap(),
    );
    let o = cmd
        .args(["plugin", "run", "pacer-notify"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(7));
    assert_eq!(
        String::from_utf8(o.stdout).unwrap(),
        format!("prefix|plugin|run|pacer-notify|BIN={}|", expected_bin())
    );
}

#[test]
fn plugin_run_without_an_id_is_a_usage_error() {
    let dir = tempfile::tempdir().unwrap();
    for bad in [vec!["plugin", "run"], vec!["plugin", "run", "a", "b"]] {
        let mut cmd = pacer();
        cmd.env(
            "PACER_CORE_ARGV",
            serde_json::to_string(&[fake_core(&dir), "prefix".to_string()]).unwrap(),
        );
        let o = cmd.args(bad).output().unwrap();
        assert_eq!(o.status.code(), Some(2));
        assert!(
            String::from_utf8(o.stderr)
                .unwrap()
                .contains("usage: pacer plugin run <id>")
        );
        // The fake core never ran for the malformed forms.
        assert_eq!(String::from_utf8(o.stdout).unwrap(), "");
    }
}

#[test]
fn other_plugin_commands_pass_through_to_core() {
    let dir = tempfile::tempdir().unwrap();
    let mut cmd = pacer();
    cmd.env(
        "PACER_CORE_ARGV",
        serde_json::to_string(&[fake_core(&dir), "prefix".to_string()]).unwrap(),
    );
    let o = cmd.args(["plugin", "list"]).output().unwrap();
    assert_eq!(o.status.code(), Some(7));
    assert_eq!(
        String::from_utf8(o.stdout).unwrap(),
        format!("prefix|plugin|list|BIN={}|", expected_bin())
    );
}
