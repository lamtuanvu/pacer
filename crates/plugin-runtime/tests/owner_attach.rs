#![allow(clippy::unwrap_used)]
//! Stdio owner probe and attach (ADR 0027): who owns a home's plugin children.
//! Kept out of the library's unit tests: binding sockets narrows the process umask.

use pacer_plugin_runtime::{
    BridgeError, HomeOwner, PeerAuth, ProcessOwner, ReverseBridge, SOCKET_PATH_MAX, SpawnSpec,
    StopOutcome, connection_socket_name, probe_home_owner, probe_home_owner_as, stop_on_owner,
};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::UnixStream,
    sync::Mutex,
};

fn short_home() -> tempfile::TempDir {
    let home = tempfile::Builder::new()
        .prefix("pnh-")
        .tempdir_in("/tmp")
        .unwrap();
    // A concurrent bind holds the process umask at 0177 while it creates the socket.
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}

#[test]
fn absent_home_and_stale_socket_mean_own() {
    let home = short_home();
    assert_eq!(probe_home_owner(home.path()), HomeOwner::Absent);
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    let path = bridge.path().to_path_buf();
    drop(bridge);
    // The listener closed, the file stayed: a crashed owner's stale socket.
    assert!(path.exists());
    assert_eq!(probe_home_owner(home.path()), HomeOwner::Absent);
}

#[test]
fn live_same_uid_owner_is_attached() {
    let home = short_home();
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Live(bridge.path().to_path_buf())
    );
}

#[test]
fn another_uid_is_never_attached() {
    let home = short_home();
    let _bridge = ReverseBridge::bind(home.path()).unwrap();
    let other = fs::metadata(home.path()).unwrap().uid().wrapping_add(1);
    assert!(matches!(
        probe_home_owner_as(home.path(), other),
        HomeOwner::Untrusted(_)
    ));
}

#[test]
fn open_or_redirected_run_directory_is_untrusted() {
    let home = short_home();
    let _bridge = ReverseBridge::bind(home.path()).unwrap();
    let run = home.path().join("run");
    fs::set_permissions(&run, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Untrusted("run directory is not private to this user")
    );
    let other = short_home();
    std::os::unix::fs::symlink(&run, other.path().join("run")).unwrap();
    assert_eq!(
        probe_home_owner(other.path()),
        HomeOwner::Untrusted("run is not a real directory")
    );
}

#[test]
fn connection_socket_binds_beside_host_sock_and_guards_length() {
    let home = short_home();
    let name = connection_socket_name([0xab, 0, 1, 2, 3, 0xff]);
    assert_eq!(name, "sab00010203ff.sock");
    let bridge = ReverseBridge::bind_at(home.path(), &name, PeerAuth::same_uid()).unwrap();
    assert_eq!(bridge.path(), home.path().join("run").join(&name));
    assert_eq!(bridge.socket_mode().unwrap(), 0o600);
    // A connection socket is not the owner lease.
    assert_eq!(probe_home_owner(home.path()), HomeOwner::Absent);

    let deep = home.path().join("x".repeat(SOCKET_PATH_MAX));
    assert!(matches!(
        ReverseBridge::bind_at(&deep, &name, PeerAuth::same_uid()),
        Err(BridgeError::PathTooLong(_))
    ));
    assert!(
        !deep.exists(),
        "the guard runs before the run dir is created"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_socket_refuses_untrusted_callers() {
    let home = short_home();
    let name = connection_socket_name([1; 6]);
    let owner = Arc::new(Mutex::new(ProcessOwner::native_for_serve()));
    let bridge = ReverseBridge::bind_at(home.path(), &name, PeerAuth::deny_all_for_tests())
        .unwrap()
        .with_live_owner(owner)
        .spawn();
    // The refusal is written before any frame is read.
    let stream = UnixStream::connect(bridge.path()).await.unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).await.unwrap();
    assert!(line.contains("unauthorized"), "{line}");
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_reaches_the_attached_owner() {
    let home = short_home();
    let owner = Arc::new(Mutex::new(ProcessOwner::native_for_serve()));
    let bridge = ReverseBridge::bind(home.path())
        .unwrap()
        .with_live_owner(Arc::clone(&owner))
        .spawn();
    let socket = bridge.path().to_path_buf();
    assert_eq!(
        stop_on_owner(&socket, "fx").await.unwrap(),
        StopOutcome::NotRunning
    );
    let spec = SpawnSpec {
        argv: vec!["/bin/sleep".into(), "30".into()],
        cwd: home.path().into(),
        env: HashMap::new(),
    };
    owner.lock().await.ensure("fx", &spec).unwrap();
    assert_eq!(
        stop_on_owner(&socket, "fx").await.unwrap(),
        StopOutcome::Stopped
    );
    assert!(owner.lock().await.find_plugin("fx").is_none());
    bridge.shutdown().await;
    assert_eq!(
        stop_on_owner(&socket, "fx").await.unwrap(),
        StopOutcome::OwnerGone
    );
}
