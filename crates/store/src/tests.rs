#![allow(clippy::unwrap_used)]
use super::*;

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
