#![allow(clippy::unwrap_used)]

use pacer_config::strategy_write::{SaveOptions, remove_strategy, save_strategy, use_strategy};
use pacer_config::{notifications, write};
use serde_json::Value;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn home() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-read/named.json"
    ))
    .unwrap();
    for (relative, content) in fixture["files"].as_object().unwrap() {
        let path = dir.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content.as_str().unwrap()).unwrap();
    }
    fs::write(dir.path().join("active"), "work\n").unwrap();
    dir
}

#[test]
fn activation_preserves_strategy_bytes_and_switches_back() {
    let dir = home();
    let named = dir.path().join("strategies/work.yaml");
    let before = fs::read(&named).unwrap();
    assert_eq!(
        use_strategy(dir.path(), "work").unwrap()["path"],
        named.to_str().unwrap()
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("active")).unwrap(),
        "work\n"
    );
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(dir.path().join("active"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(fs::read(&named).unwrap(), before);
    assert_eq!(
        use_strategy(dir.path(), "default").unwrap()["name"],
        "default"
    );
    assert!(!dir.path().join("active").exists());
    assert_eq!(fs::read(&named).unwrap(), before);
}

#[test]
fn failed_activation_and_protected_removal_leave_files_alone() {
    let dir = home();
    let active = fs::read(dir.path().join("active")).unwrap();
    assert_eq!(
        use_strategy(dir.path(), "missing").unwrap_err().to_string(),
        "unknown strategy \"missing\""
    );
    assert!(use_strategy(dir.path(), "broken").is_err());
    assert_eq!(
        remove_strategy(dir.path(), "default")
            .unwrap_err()
            .to_string(),
        "invalid strategy name \"default\"; default is protected"
    );
    assert_eq!(
        remove_strategy(dir.path(), "work").unwrap_err().to_string(),
        "cannot delete the active strategy"
    );
    assert_eq!(fs::read(dir.path().join("active")).unwrap(), active);
    assert!(dir.path().join("strategies/work.yaml").exists());
}

#[test]
fn removal_deletes_only_inactive_named_file() {
    let dir = home();
    use_strategy(dir.path(), "default").unwrap();
    assert_eq!(
        remove_strategy(dir.path(), "work").unwrap(),
        serde_json::json!({"name":"work","deleted":true})
    );
    assert!(!dir.path().join("strategies/work.yaml").exists());
    assert!(dir.path().join("strategy.yaml").exists());
    assert_eq!(
        remove_strategy(dir.path(), "work").unwrap_err().to_string(),
        "unknown strategy \"work\""
    );
}

#[cfg(unix)]
#[test]
fn activation_modes_under_both_umasks() {
    let executable = std::env::current_exe().unwrap();
    for mask in ["022", "077"] {
        let output = std::process::Command::new("sh")
            .args(["-c", "umask \"$1\"; shift; exec \"$@\"", "sh", mask])
            .arg(&executable)
            .args([
                "--exact",
                "activation_modes_under_umask_child",
                "--nocapture",
            ])
            .env("PACER_STRATEGY_UMASK_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mask {mask}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "mask {mask}: child test did not run"
        );
    }
}

#[cfg(unix)]
#[test]
fn activation_modes_under_umask_child() {
    if std::env::var_os("PACER_STRATEGY_UMASK_CHILD").is_none() {
        return;
    }
    let dir = home();
    let active = dir.path().join("active");
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&active, fs::Permissions::from_mode(0o644)).unwrap();
    use_strategy(dir.path(), "work").unwrap();
    assert_eq!(
        fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(active).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let settings = dir.path().join("settings.json");
    fs::write(&settings, "{}").unwrap();
    fs::set_permissions(&settings, fs::Permissions::from_mode(0o644)).unwrap();
    notifications::set_level(dir.path(), "all").unwrap();
    assert_eq!(
        fs::metadata(&settings).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let strategies = dir.path().join("strategies");
    fs::set_permissions(&strategies, fs::Permissions::from_mode(0o755)).unwrap();
    save_strategy(
        dir.path(),
        "review",
        &serde_json::json!({"from":"default","description":""}),
        "approved",
        SaveOptions {
            who: "agent",
            now_iso: "2026-11-01T00:00:00.000Z",
            overwrite: false,
            active_ok: false,
        },
    )
    .unwrap();
    assert_eq!(
        fs::metadata(&strategies).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let review = strategies.join("review.yaml");
    assert_eq!(
        fs::metadata(review).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let default = dir.path().join("strategy.yaml");
    fs::set_permissions(&default, fs::Permissions::from_mode(0o644)).unwrap();
    write::atomic_strategy_write(&default, "private\n").unwrap();
    assert_eq!(
        fs::metadata(default).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
