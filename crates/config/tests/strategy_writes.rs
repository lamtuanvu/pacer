#![allow(clippy::unwrap_used)]

use pacer_config::strategy_write::{remove_strategy, use_strategy};
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
