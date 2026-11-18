#![allow(clippy::unwrap_used)]
//! Stdio owner probe and attach (ADR 0027): who owns a home's plugin children,
//! and where a connection binds its own socket.

use pacer_plugin_runtime::{
    AttachError, BridgeError, HOST_KEY_NAME, HomeOwner, OwnerKey, OwnerTrust, PeerAuth,
    ProcessOwner, ReverseBridge, SOCKET_PATH_MAX, SpawnSpec, StopOutcome, connection_socket_name,
    prepare_run_dir, probe_home_owner, probe_home_owner_as, stop_on_owner, stop_on_owner_as,
};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::UnixStream,
    sync::Mutex,
};

fn short_home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("pnh-")
        .tempdir_in("/tmp")
        .unwrap()
}

fn me() -> u32 {
    nix::unistd::getuid().as_raw()
}

fn key() -> OwnerKey {
    OwnerKey::generate().unwrap()
}

/// Publish `key` as serve does after binding `host.sock`.
fn publish(home: &Path, key: &OwnerKey, mode: u32) {
    let path = home.join("run").join(HOST_KEY_NAME);
    let _ = fs::remove_file(&path);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&path)
        .unwrap();
    writeln!(file, "{}", key.to_hex()).unwrap();
}

/// A bound serve owner with its published key.
fn serve_bridge(home: &Path) -> ReverseBridge {
    let bridge = ReverseBridge::bind(home).unwrap();
    publish(home, &bridge.auth().key, 0o600);
    bridge
}

/// macOS marks a new socket close-on-exec only after creating it, so a child spawned
/// meanwhile can keep a listener open after the test closes it.
static SPAWNS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn no_spawns() -> std::sync::MutexGuard<'static, ()> {
    SPAWNS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[test]
fn absent_home_and_stale_socket_mean_own() {
    let _spawns = no_spawns();
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
    let bridge = serve_bridge(home.path());
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Live(bridge.path().to_path_buf(), bridge.auth().key.clone())
    );
}

#[test]
fn an_owner_without_a_private_current_key_is_never_attached() {
    let home = short_home();
    // A live socket alone is not enough: nothing to prove to the owner.
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Untrusted("host.sock has no published credential")
    );
    publish(home.path(), &bridge.auth().key, 0o644);
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Untrusted("host.key is not private to this user")
    );
    let path = home.path().join("run").join(HOST_KEY_NAME);
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink("/dev/null", &path).unwrap();
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Untrusted("host.key is unreadable")
    );
    drop(bridge);

    // A crashed serve's key, older than the live socket, is never used.
    let home = short_home();
    prepare_run_dir(home.path()).unwrap();
    publish(home.path(), &key(), 0o600);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let _bridge = ReverseBridge::bind(home.path()).unwrap();
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Untrusted("host.sock has no published credential")
    );
}

#[test]
fn another_uid_is_never_attached() {
    let home = short_home();
    let _bridge = ReverseBridge::bind(home.path()).unwrap();
    let other = fs::metadata(home.path()).unwrap().uid().wrapping_add(1);
    assert!(matches!(
        probe_home_owner_as(home.path(), OwnerTrust::user(other)),
        HomeOwner::Untrusted(_)
    ));
}

#[test]
fn each_trust_layer_refuses_a_foreign_uid_on_its_own() {
    let home = short_home();
    let bridge = serve_bridge(home.path());
    let other = me().wrapping_add(1);
    let mine = OwnerTrust::user(me());
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Live(bridge.path().to_path_buf(), bridge.auth().key.clone())
    );
    for (trust, reason) in [
        (
            OwnerTrust {
                run_dir: other,
                ..mine
            },
            "run directory is not private to this user",
        ),
        (
            OwnerTrust {
                socket: other,
                ..mine
            },
            "host.sock belongs to another user",
        ),
        (
            OwnerTrust {
                peer: other,
                ..mine
            },
            "host.sock is served by another user",
        ),
    ] {
        assert_eq!(
            probe_home_owner_as(home.path(), trust),
            HomeOwner::Untrusted(reason)
        );
    }
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
    let bridge = ReverseBridge::bind_at(home.path(), &name, PeerAuth::same_uid(key())).unwrap();
    assert_eq!(bridge.path(), home.path().join("run").join(&name));
    assert_eq!(bridge.socket_mode().unwrap(), 0o600);
    // A connection socket is not the owner lease.
    assert_eq!(probe_home_owner(home.path()), HomeOwner::Absent);
    let other = connection_socket_name([0xcd; 6]);
    let connection =
        ReverseBridge::bind_connection(home.path(), &other, PeerAuth::same_uid(key())).unwrap();
    assert_eq!(connection.path(), home.path().join("run").join(&other));
    assert_eq!(connection.socket_mode().unwrap(), 0o600);

    let deep = home.path().join("x".repeat(SOCKET_PATH_MAX));
    assert!(matches!(
        ReverseBridge::bind_at(&deep, &name, PeerAuth::same_uid(key())),
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
    let bridge = ReverseBridge::bind_at(home.path(), &name, PeerAuth::deny_all_for_tests(key()))
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
        .with_live_owner(Arc::clone(&owner));
    let socket = bridge.path().to_path_buf();
    let owner_key = bridge.auth().key.clone();
    let bridge = bridge.spawn();
    assert_eq!(
        stop_on_owner(&socket, &owner_key, "fx").await.unwrap(),
        StopOutcome::NotRunning
    );
    // A peer that is not the expected user never receives the stop frame.
    assert!(matches!(
        stop_on_owner_as(&socket, &owner_key, "fx", me().wrapping_add(1)).await,
        Err(AttachError::Untrusted)
    ));
    // An owner that cannot prove this key never receives it either.
    assert!(matches!(
        stop_on_owner(&socket, &key(), "fx").await,
        Err(AttachError::Unproven)
    ));
    let spec = SpawnSpec {
        argv: vec!["/bin/sleep".into(), "30".into()],
        cwd: home.path().into(),
        env: HashMap::new(),
    };
    let mut supervisor = owner.lock().await;
    {
        let _spawns = no_spawns();
        supervisor.ensure("fx", &spec).unwrap();
    }
    drop(supervisor);
    assert_eq!(
        stop_on_owner(&socket, &owner_key, "fx").await.unwrap(),
        StopOutcome::Stopped
    );
    assert!(owner.lock().await.find_plugin("fx").is_none());
    bridge.shutdown().await;
    assert_eq!(
        stop_on_owner(&socket, &owner_key, "fx").await.unwrap(),
        StopOutcome::OwnerGone
    );
}

/// The OS per-user private directory, as the door finds it.
fn user_private_dir() -> Option<std::path::PathBuf> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("/usr/bin/getconf")
            .arg("DARWIN_USER_TEMP_DIR")
            .output()
            .ok()?;
        let text = String::from_utf8(out.stdout).ok()?;
        Some(text.trim_end_matches('\n').trim_end_matches('/').into())
    } else {
        std::env::var_os("XDG_RUNTIME_DIR").map(Into::into)
    }
}

#[test]
fn a_deep_home_binds_its_connection_socket_in_the_private_user_directory() {
    let _spawns = no_spawns();
    let root = short_home();
    let deep = root.path().join("d".repeat(SOCKET_PATH_MAX));
    let name = connection_socket_name([7; 6]);
    let bound = ReverseBridge::bind_connection(&deep, &name, PeerAuth::same_uid(key()));
    let Some(base) = user_private_dir() else {
        // No per-user directory (for example Linux without XDG_RUNTIME_DIR): refuse, never /tmp.
        let message = bound.err().unwrap().to_string();
        assert!(message.contains("PACER_NATIVE_PLUGIN_HOST=0"), "{message}");
        return;
    };
    let bridge = bound.unwrap();
    let dir = bridge.path().parent().unwrap().to_path_buf();
    assert_eq!(dir.parent().unwrap(), base);
    assert!(
        dir.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("pacer-")
    );
    assert!(bridge.path().as_os_str().len() <= SOCKET_PATH_MAX);
    assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
    assert_eq!(bridge.socket_mode().unwrap(), 0o600);
    assert!(
        !deep.exists(),
        "the deep home's run directory is never created"
    );
    let again = ReverseBridge::bind_connection(
        &deep,
        &connection_socket_name([8; 6]),
        PeerAuth::same_uid(key()),
    )
    .unwrap();
    assert_eq!(again.path().parent().unwrap(), dir);
    for socket in [bridge.path(), again.path()] {
        fs::remove_file(socket).unwrap();
    }
    fs::remove_dir(&dir).unwrap();
}
