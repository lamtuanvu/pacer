#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn strategy_switch_records_alert_activity_and_config_in_order() {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        tmp.path().join("home"),
        tmp.path().join("pacer"),
        Default::default(),
        1_700_000_000.0,
    );
    record_strategy_switch(&ctx, "research").unwrap();
    let rows: Vec<Value> = fs::read_to_string(ctx.pacer_home.join("link/outbox.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["envelope"]["type"], "alert");
    assert_eq!(
        rows[0]["envelope"]["data"]["title"],
        "Switched to strategy research"
    );
    assert_eq!(rows[1]["envelope"]["type"], "entity");
    assert_eq!(rows[2]["envelope"]["type"], "config");
    assert_eq!(rows[2]["envelope"]["data"]["area"], "strategy");
    let latest: Value =
        serde_json::from_slice(&fs::read(ctx.pacer_home.join("link/latest.json")).unwrap())
            .unwrap();
    assert_eq!(
        latest["alerts"][0]["title"],
        "Switched to strategy research"
    );
    assert_eq!(latest["seq"], 3);
}

#[cfg(unix)]
#[test]
fn private_append_refuses_symlink_without_touching_target() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("outside");
    fs::write(&target, b"untouched").unwrap();
    let private = dir.path().join("state");
    fs::create_dir_all(&private).unwrap();
    symlink(&target, private.join("activity.jsonl")).unwrap();
    assert!(append_private(&private.join("activity.jsonl"), b"bad\n").is_err());
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
    fs::remove_file(private.join("activity.jsonl")).unwrap();
    symlink(&target, private.join("outbox.jsonl")).unwrap();
    assert!(append_private(&private.join("outbox.jsonl"), b"bad\n").is_err());
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
}

#[cfg(unix)]
#[test]
fn private_append_refuses_symlink_directory() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("outside");
    fs::create_dir_all(&target).unwrap();
    for (directory, file) in [("state", "activity.jsonl"), ("link", "outbox.jsonl")] {
        let link = dir.path().join(directory);
        symlink(&target, &link).unwrap();
        assert!(append_private(&link.join(file), b"bad\n").is_err());
        assert!(!target.join(file).exists());
    }
}

#[cfg(unix)]
#[test]
fn private_append_rejects_fifo_without_waiting_for_reader() {
    use std::{os::unix::fs::OpenOptionsExt, process::Command, sync::mpsc, time::Duration};
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    fs::create_dir_all(&state).unwrap();
    let fifo = state.join("activity.jsonl");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let (sender, receiver) = mpsc::channel();
    let append_path = fifo.clone();
    std::thread::spawn(move || {
        let _ = sender.send(append_private(&append_path, b"bad\n"));
    });
    let result = receiver.recv_timeout(Duration::from_millis(300)).unwrap();
    assert!(result.is_err());
    let reader = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&fifo)
        .unwrap();
    assert!(append_private(&fifo, b"bad\n").is_err());
    drop(reader);
}
