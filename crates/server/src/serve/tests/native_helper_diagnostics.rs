#![allow(clippy::unwrap_used)]
use super::*;
use std::{fs, os::unix::fs::PermissionsExt};
fn home() -> tempfile::TempDir {
    let home = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}
#[test]
fn appends_only_fixed_stage_numeric_identity_records_in_private_file() {
    let home = home();
    let diagnostics = Diagnostics {
        log: Some(Log::open(home.path()).unwrap()),
        root: 123,
        core: 456,
    };
    diagnostics.record(Stage::Asset, Event::Failed);
    let path = home.path().join("logs/native-helper.log");
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["root_pid"], 123);
    assert_eq!(value["core_pid"], 456);
    assert_eq!(value["stage"], "asset");
    assert_eq!(value["event"], "failed");
    let object = value.as_object().unwrap();
    assert_eq!(object.len(), 5);
    assert!(object.contains_key("at_ms"));
    assert!(bytes.ends_with(b"\n"));
}
#[test]
fn refuses_redirected_broad_hardlinked_and_nonregular_log_targets() {
    use std::os::unix::fs::symlink;
    for kind in ["symlink", "hardlink", "broad", "directory"] {
        let home = home();
        let logs = home.path().join("logs");
        fs::create_dir(&logs).unwrap();
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o700)).unwrap();
        let external = home.path().join("untouched");
        fs::write(&external, b"untouched").unwrap();
        fs::set_permissions(&external, fs::Permissions::from_mode(0o600)).unwrap();
        let path = logs.join("native-helper.log");
        match kind {
            "symlink" => symlink(&external, &path).unwrap(),
            "hardlink" => fs::hard_link(&external, &path).unwrap(),
            "broad" => {
                fs::write(&path, b"broad").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            }
            _ => fs::create_dir(&path).unwrap(),
        }
        let diagnostics = Diagnostics::new(home.path(), 123, 456);
        diagnostics.record(Stage::Spawn, Event::Failed);
        assert_eq!(fs::read(&external).unwrap(), b"untouched");
        if kind == "broad" {
            assert_eq!(fs::read(&path).unwrap(), b"broad");
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o644
            );
        }
    }
    let home = home();
    let outside = home.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::set_permissions(&outside, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&outside, home.path().join("logs")).unwrap();
    Diagnostics::new(home.path(), 1, 2).record(Stage::Asset, Event::Failed);
    assert!(!outside.join("native-helper.log").exists());
}
#[test]
fn held_parent_and_file_replacement_stop_writes_without_redirect_cleanup() {
    for replace_parent in [false, true] {
        let home = home();
        let diagnostics = Diagnostics::new(home.path(), 123, 456);
        diagnostics.record(Stage::Asset, Event::Enter);
        let logs = home.path().join("logs");
        let path = logs.join("native-helper.log");
        if replace_parent {
            fs::rename(&logs, home.path().join("old-logs")).unwrap();
            fs::create_dir(&logs).unwrap();
            fs::set_permissions(&logs, fs::Permissions::from_mode(0o700)).unwrap();
        } else {
            fs::rename(&path, logs.join("old.log")).unwrap();
        }
        fs::write(&path, b"replacement").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        diagnostics.record(Stage::Spawn, Event::Failed);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
    }
}
#[test]
fn external_nonblocking_flock_skips_append_and_releases_without_wait() {
    let home = home();
    let diagnostics = Diagnostics::new(home.path(), 123, 456);
    let path = home.path().join("logs/native-helper.log");
    let file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap();
    let now = std::time::Instant::now();
    diagnostics.record(Stage::StaticRole, Event::Enter);
    assert!(now.elapsed() < std::time::Duration::from_secs(1));
    assert!(fs::read(&path).unwrap().is_empty());
    drop(lock);
    diagnostics.record(Stage::StaticRole, Event::Failed);
    assert!(!fs::read(path).unwrap().is_empty());
}
#[test]
fn hard_cap_keeps_whole_records_without_rotating_or_truncating() {
    let home = home();
    let diagnostics = Diagnostics::new(home.path(), 123, 456);
    for _ in 0..1000 {
        diagnostics.record(Stage::DynamicImage, Event::Enter);
    }
    let path = home.path().join("logs/native-helper.log");
    let before = fs::read(&path).unwrap();
    assert!(before.len() as u64 <= CAP);
    assert!(before.len() > CAP as usize - 256);
    diagnostics.record(Stage::DynamicImage, Event::Failed);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(before.ends_with(b"\n"));
    for line in before.split(|b| *b == b'\n').filter(|v| !v.is_empty()) {
        assert!(serde_json::from_slice::<serde_json::Value>(line).is_ok());
    }
    assert_eq!(fs::read_dir(home.path().join("logs")).unwrap().count(), 1);
}
#[test]
fn cap_and_private_file_hold_across_separate_root_processes() {
    if let Some(path) = std::env::var_os("PACER_DIAGNOSTIC_APPEND_CHILD") {
        let diagnostics = Diagnostics::new(Path::new(&path), 123, 456);
        for _ in 0..1000 {
            diagnostics.record(Stage::Handoff, Event::Handoff);
        }
        return;
    }
    let home = home();
    let executable = std::env::current_exe().unwrap();
    let mut children=(0..4).map(|_|std::process::Command::new(&executable).args(["--exact","serve::native_helper_diagnostics::tests::cap_and_private_file_hold_across_separate_root_processes"]).env("PACER_DIAGNOSTIC_APPEND_CHILD",home.path()).stdout(std::process::Stdio::null()).spawn().unwrap()).collect::<Vec<_>>();
    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    let bytes = fs::read(home.path().join("logs/native-helper.log")).unwrap();
    assert!(!bytes.is_empty());
    assert!(bytes.len() as u64 <= CAP);
    for line in bytes.split(|b| *b == b'\n').filter(|v| !v.is_empty()) {
        assert!(serde_json::from_slice::<serde_json::Value>(line).is_ok());
    }
}
#[tokio::test]
async fn real_broker_denial_records_failed_stage_and_logging_cannot_grant_authority() {
    use super::super::{
        native_helper::Broker,
        native_trust::{NativeTrust, ProcessDetails, ProcessIdentity},
    };
    use std::{os::unix::net::UnixStream, sync::Arc};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for logger_available in [true, false] {
        let home = home();
        let outside = home.path().join("untouched");
        if !logger_available {
            let logs = home.path().join("logs");
            fs::create_dir(&logs).unwrap();
            fs::set_permissions(&logs, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(&outside, b"untouched").unwrap();
            std::os::unix::fs::symlink(&outside, logs.join("native-helper.log")).unwrap();
        }
        let identity = ProcessIdentity {
            pid: std::process::id(),
            boot_id: "test".into(),
            birth: "test".into(),
        };
        let broker = Broker {
            trust: NativeTrust::from_pins(None, Some(&"A".repeat(40)))
                .unwrap()
                .unwrap(),
            home: home.path().into(),
            user_home: home.path().into(),
            port: 12345,
            root: identity.clone(),
            front: home.path().join("pacer"),
            generation: ProcessDetails {
                process: identity,
                uid: 501,
                parent_pid: 1,
                executable: home.path().join("pacer-core"),
            },
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
        };
        let (parent, remote) = UnixStream::pair().unwrap();
        remote.set_nonblocking(true).unwrap();
        let mut remote = tokio::net::UnixStream::from_std(remote).unwrap();
        let task = tokio::spawn(broker.run(parent));
        remote.write_all(&[0, 0, 0, 2, b'{', b'}']).await.unwrap();
        let mut reply = [0; 5];
        remote.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [b'E', 0, 0, 0, 0]);
        task.await.unwrap();
        if logger_available {
            let lines = fs::read_to_string(home.path().join("logs/native-helper.log")).unwrap();
            let records = lines
                .lines()
                .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
                .collect::<Vec<_>>();
            assert!(
                records
                    .iter()
                    .any(|v| v["stage"] == "request" && v["event"] == "failed")
            );
            assert!(records.iter().any(|v| v["event"] == "end"));
            assert!(
                records
                    .iter()
                    .any(|v| v["stage"] == "read-first-byte" && v["event"] == "enter")
            );
            assert!(!records.iter().any(|v| v["stage"] == "spawn"));
        } else {
            assert_eq!(fs::read(&outside).unwrap(), b"untouched");
        }
    }
}

#[test]
fn request_timing_and_write_failures_reveal_only_fixed_numeric_or_enum_evidence() {
    let home = home();
    let diagnostics = Diagnostics::new(home.path(), 123, 456);
    diagnostics.request_started(123);
    for (errno, expected) in [
        (nix::libc::EPIPE, "write-epipe"),
        (nix::libc::EAGAIN, "write-would-block"),
        (nix::libc::EBADF, "write-bad-fd"),
        (nix::libc::EINVAL, "write-invalid"),
        (nix::libc::EPERM, "write-permission"),
        (nix::libc::EACCES, "write-access"),
        (nix::libc::EMSGSIZE, "write-message-size"),
        (nix::libc::ECONNRESET, "write-connection-reset"),
        (nix::libc::ENOBUFS, "write-no-buffers"),
        (nix::libc::ENOTSOCK, "write-not-socket"),
        (nix::libc::EINTR, "write-interrupted"),
        (nix::libc::EIO, "write-other"),
    ] {
        let event = Event::write_failure(&io::Error::from_raw_os_error(errno));
        assert_eq!(event.name(), expected);
        diagnostics.record(Stage::Handoff, event);
    }
    diagnostics.record(
        Stage::Handoff,
        Event::write_failure(&io::Error::other(
            "private path or secret must never be serialized",
        )),
    );
    let bytes = fs::read_to_string(home.path().join("logs/native-helper.log")).unwrap();
    assert!(!bytes.contains("secret"));
    let records = bytes
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records[0]["started_at_ms"], 123);
    assert_eq!(records[0]["event"], "request-timing");
    assert!(records[0]["request_age_ms"].as_i64().unwrap() <= 86_400_000);
    assert_eq!(records[0].as_object().unwrap().len(), 7);
}
