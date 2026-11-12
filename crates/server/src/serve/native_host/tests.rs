#![allow(clippy::unwrap_used)]
use super::*;
use pacer_plugin_runtime::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, NATIVE_PLUGIN_HOST_ENABLE_ENV,
};
use std::{fs, os::unix::fs::PermissionsExt};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flag_off_leaves_env_and_socket_untouched() {
    let home = tempfile::tempdir().unwrap();
    let mut env = HashMap::new();
    env.insert("PACER_HOME".into(), home.path().display().to_string());
    assert!(maybe_start(home.path(), &mut env).await.unwrap().is_none());
    assert!(!env.contains_key(HOST_SOCKET_ENV));
    assert!(!home.path().join("run").join("host.sock").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zero_escape_leaves_path_dark_even_with_bridge_yes() {
    let home = tempfile::tempdir().unwrap();
    let mut env = HashMap::new();
    env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "0".into());
    env.insert(HOST_BRIDGE_ENABLE_ENV.into(), "yes".into());
    assert!(maybe_start(home.path(), &mut env).await.unwrap().is_none());
    assert!(!env.contains_key(HOST_SOCKET_ENV));
    assert!(!home.path().join("run").join("host.sock").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flag_on_sets_socket_env_and_cleans_up() {
    let home = tempfile::tempdir().unwrap();
    let mut env = HashMap::new();
    env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "1".into());
    let guard = maybe_start(home.path(), &mut env).await.unwrap().unwrap();
    let socket = env.get(HOST_SOCKET_ENV).cloned().unwrap();
    assert!(Path::new(&socket).exists());
    assert_eq!(
        fs::symlink_metadata(home.path().join("run"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let sidecar = home.path().join("run").join("host.sock.pid");
    assert_eq!(
        fs::read_to_string(&sidecar).unwrap().trim(),
        std::process::id().to_string()
    );
    assert_eq!(
        fs::symlink_metadata(&sidecar).unwrap().permissions().mode() & 0o777,
        0o600
    );
    guard.shutdown().await;
    assert!(!Path::new(&socket).exists());
    assert!(!sidecar.exists());
}

fn flag_on(wait_ms: u64) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "1".into());
    env.insert(OWNER_WAIT_ENV.into(), wait_ms.to_string());
    env
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_owner_refuses_a_second_serve_after_the_bounded_wait() {
    let home = tempfile::tempdir().unwrap();
    let first = maybe_start(home.path(), &mut flag_on(0))
        .await
        .unwrap()
        .unwrap();
    let started = std::time::Instant::now();
    let error = match maybe_start(home.path(), &mut flag_on(600)).await {
        Err(error) => error,
        Ok(_) => panic!("a second owner started"),
    };
    assert!(started.elapsed() >= Duration::from_millis(600));
    assert_eq!(exit_code(&error), EXIT_HOME_OWNED);
    let socket = home.path().join("run").join("host.sock");
    assert_eq!(
        error.to_string(),
        format!(
            "another pacer owns the plugin host socket at {} (pid {}): stop the other pacer \
             (pacer service stop) or wait for it to exit",
            socket.display(),
            std::process::id()
        )
    );
    assert_eq!(exit_code(&io::Error::other("other")), 1);
    // The refused serve left the owner's socket and sidecar alone.
    assert!(socket.exists());
    assert!(home.path().join("run").join("host.sock.pid").exists());
    first.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_serve_waiting_on_an_exiting_owner_starts_once_it_is_gone() {
    let home = tempfile::tempdir().unwrap();
    let first = maybe_start(home.path(), &mut flag_on(0))
        .await
        .unwrap()
        .unwrap();
    let stop = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        first.shutdown().await;
    });
    let second = maybe_start(home.path(), &mut flag_on(5000))
        .await
        .unwrap()
        .unwrap();
    stop.await.unwrap();
    assert!(home.path().join("run").join("host.sock").exists());
    second.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_socket_is_replaced_without_waiting() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    fs::create_dir(&run).unwrap();
    fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).unwrap();
    drop(std::os::unix::net::UnixListener::bind(run.join("host.sock")).unwrap());
    fs::write(run.join("host.sock.pid"), "1\n").unwrap();
    let started = std::time::Instant::now();
    let guard = maybe_start(home.path(), &mut flag_on(5000))
        .await
        .unwrap()
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        fs::read_to_string(run.join("host.sock.pid"))
            .unwrap()
            .trim(),
        std::process::id().to_string()
    );
    guard.shutdown().await;
}
