#![allow(clippy::unwrap_used)]
//! Stdio owner probe and attach (ADR 0027): who owns a home's plugin children,
//! and where a connection binds its own socket.

use pacer_plugin_runtime::{
    AttachError, BridgeError, HomeOwner, OwnerTrust, PeerAuth, ProcessOwner, ReverseBridge,
    SOCKET_PATH_MAX, SpawnSpec, StopOutcome, connection_socket_name, probe_home_owner,
    probe_home_owner_as, stop_on_owner, stop_on_owner_as,
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
    tempfile::Builder::new()
        .prefix("pnh-")
        .tempdir_in("/tmp")
        .unwrap()
}

fn me() -> u32 {
    nix::unistd::getuid().as_raw()
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
        probe_home_owner_as(home.path(), OwnerTrust::user(other)),
        HomeOwner::Untrusted(_)
    ));
}

#[test]
fn each_trust_layer_refuses_a_foreign_uid_on_its_own() {
    let home = short_home();
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    let other = me().wrapping_add(1);
    let mine = OwnerTrust::user(me());
    assert_eq!(
        probe_home_owner(home.path()),
        HomeOwner::Live(bridge.path().to_path_buf())
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
    let bridge = ReverseBridge::bind_at(home.path(), &name, PeerAuth::same_uid()).unwrap();
    assert_eq!(bridge.path(), home.path().join("run").join(&name));
    assert_eq!(bridge.socket_mode().unwrap(), 0o600);
    // A connection socket is not the owner lease.
    assert_eq!(probe_home_owner(home.path()), HomeOwner::Absent);
    let other = connection_socket_name([0xcd; 6]);
    let connection =
        ReverseBridge::bind_connection(home.path(), &other, PeerAuth::same_uid()).unwrap();
    assert_eq!(connection.path(), home.path().join("run").join(&other));
    assert_eq!(connection.socket_mode().unwrap(), 0o600);

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
    // A peer that is not the expected user never receives the stop frame.
    assert!(matches!(
        stop_on_owner_as(&socket, "fx", me().wrapping_add(1)).await,
        Err(AttachError::Untrusted)
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
    let bound = ReverseBridge::bind_connection(&deep, &name, PeerAuth::same_uid());
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
        PeerAuth::same_uid(),
    )
    .unwrap();
    assert_eq!(again.path().parent().unwrap(), dir);
    for socket in [bridge.path(), again.path()] {
        fs::remove_file(socket).unwrap();
    }
    fs::remove_dir(&dir).unwrap();
}
