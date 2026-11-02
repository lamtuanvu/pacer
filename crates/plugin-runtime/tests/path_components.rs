#![allow(clippy::unwrap_used)]
use pacer_plugin_runtime::native_run::directory::RunDirectory;
use std::{fs, os::unix::fs::PermissionsExt};
const TASK: &str = "t-20261102-175253-93d8";
fn home() -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("pacer-run-paths-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    home
}
#[test]
fn run_directory_refuses_unsafe_task_ids_before_creating_or_opening_paths() {
    let home = home();
    // Existing escape destination proves rejection is validation, not a missing path.
    fs::create_dir_all(home.join("outside/1")).unwrap();
    for id in [
        "../outside",
        "..",
        ".",
        "",
        "/absolute",
        "a/b",
        "a\\b",
        "a\0b",
        "a∕b",
        "a／b",
        "t-é",
    ] {
        assert!(RunDirectory::claim(&home, id, 1, true).is_err(), "{id:?}");
        assert!(RunDirectory::existing(&home, id, 1).is_err(), "{id:?}");
    }
    assert!(!home.join("runs").exists());
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn run_file_names_cannot_read_replace_or_publish_outside_the_run() {
    let home = home();
    let run = RunDirectory::claim(&home, TASK, 1, false).unwrap();
    let sentinel = home.join("runs").join(TASK).join("sentinel");
    fs::write(&sentinel, "private").unwrap();
    let absolute = sentinel.to_str().unwrap();
    for name in [
        "../sentinel",
        absolute,
        "..",
        ".",
        "",
        "a/b",
        "a\\b",
        "a\0b",
        "a∕b",
        "a／b",
    ] {
        assert!(run.bytes(name, 100).is_err(), "read {name:?}");
        assert!(run.write(name, b"changed").is_err(), "write {name:?}");
        assert!(
            run.publish(name, b"created", 0o600).is_err(),
            "publish {name:?}"
        );
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "private");
    }
    for name in [
        "stdout",
        "stderr",
        "run.sh",
        "claude-settings.json",
        ".private",
        "admission.complete",
    ] {
        run.publish(name, b"owned", 0o600).unwrap();
        assert_eq!(run.bytes(name, 100).unwrap().unwrap(), b"owned");
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn orca_profile_ids_stay_in_their_profile_directory_using_the_ts_account_rule() {
    use pacer_plugin_runtime::orca_policy::{LoginEnvironment, account_environment};
    use serde_json::json;
    let home = home();
    let root = fs::canonicalize(&home).unwrap();
    let profiles = root.join("codex-accounts");
    for id in ["account", "A0_-", "owned.profile"] {
        let folder = profiles.join(id).join("home");
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            account_environment(
                &json!({"source":"orca","kind":"codex","orcaAccount":id}),
                "codex",
                &home,
                root.to_str(),
                &LoginEnvironment::default()
            )
            .unwrap()["CODEX_HOME"],
            folder.to_str().unwrap()
        );
    }
    for id in [
        "",
        ".",
        "..",
        "../outside",
        "/absolute",
        "a/b",
        "a\\b",
        "a\0b",
        "a∕b",
        "a／b",
        "a\u{2028}b",
    ] {
        assert!(
            account_environment(
                &json!({"source":"orca","kind":"codex","orcaAccount":id}),
                "codex",
                &home,
                root.to_str(),
                &LoginEnvironment::default()
            )
            .is_err(),
            "{id:?}"
        );
    }
    fs::remove_dir_all(home).unwrap();
}
