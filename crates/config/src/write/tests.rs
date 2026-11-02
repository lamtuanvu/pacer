#![allow(clippy::unwrap_used)]

use super::atomic_strategy_write;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;

#[test]
fn replaces_existing_strategy_and_keeps_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    fs::write(&path, "old\n").unwrap();
    #[cfg(unix)]
    {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    atomic_strategy_write(&path, "new\n").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn missing_strategy_is_refused_without_creating_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    assert_eq!(
        atomic_strategy_write(&path, "new\n").unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
    assert!(!path.exists());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn directory_target_does_not_change_parent_permissions() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("parent");
    fs::create_dir(&target).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        atomic_strategy_write(&target, "new\n").unwrap_err().kind(),
        std::io::ErrorKind::IsADirectory
    );
    assert_eq!(
        fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert!(fs::read_dir(&target).unwrap().next().is_none());
}

#[test]
fn relative_strategy_paths_match_typescript() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    for relative in ["strategy.yaml", "./strategy.yaml"] {
        fs::write(&path, "old\n").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("write::tests::write_relative_strategy_child")
            .current_dir(dir.path())
            .env("PACER_CONFIG_RELATIVE_PATH", relative)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{relative}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
    fs::write(&path, "old\n").unwrap();
    assert!(atomic_strategy_write(Path::new(&format!("{}/", path.display())), "new\n").is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "old\n");
}

#[test]
fn write_relative_strategy_child() {
    let Ok(path) = std::env::var("PACER_CONFIG_RELATIVE_PATH") else {
        return;
    };
    atomic_strategy_write(Path::new(&path), "new\n").unwrap();
}

#[cfg(unix)]
#[test]
fn symlinked_parent_matches_typescript_writer() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("strategy.yaml"), "old\n").unwrap();
    let link = dir.path().join("link");
    symlink(&real, &link).unwrap();
    atomic_strategy_write(&link.join("strategy.yaml"), "new\n").unwrap();
    assert_eq!(
        fs::read_to_string(real.join("strategy.yaml")).unwrap(),
        "new\n"
    );
}

#[cfg(unix)]
#[test]
fn both_umasks_tighten_existing_mode_and_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    fs::write(&path, "old\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    for mask in ["022", "077"] {
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let output = Command::new("sh")
            .args([
                "-c",
                "umask \"$1\"; exec \"$2\" --exact write::tests::write_under_umask",
                "sh",
                mask,
            ])
            .arg(std::env::current_exe().unwrap())
            .env("PACER_CONFIG_UMASK_TEST_PATH", &path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[cfg(unix)]
#[test]
fn write_under_umask() {
    let Ok(path) = std::env::var("PACER_CONFIG_UMASK_TEST_PATH") else {
        return;
    };
    atomic_strategy_write(std::path::Path::new(&path), "new\n").unwrap();
}
