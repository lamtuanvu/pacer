#![allow(clippy::unwrap_used)]
use super::*;
use pacer_plugin_runtime::{
    HOST_BRIDGE_ENABLE_ENV, HOST_KEY_NAME, HOST_SOCKET_ENV, NATIVE_PLUGIN_HOST_ENABLE_ENV,
    OwnerKey, PeerAuth, ReverseBridge, SOCKET_PATH_MAX,
};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
};

/// The OS per-user private directory, as the door finds it.
fn user_private_dir() -> Option<PathBuf> {
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

/// A home whose `run/host.sock` cannot fit in `sockaddr_un`.
fn deep_home(root: &Path) -> PathBuf {
    root.join("d".repeat(SOCKET_PATH_MAX))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flag_off_leaves_env_and_socket_untouched() {
    let home = tempfile::tempdir().unwrap();
    let mut env = HashMap::new();
    env.insert("PACER_HOME".into(), home.path().display().to_string());
    // A credential only ever comes from the owner this serve starts.
    env.insert(HOST_SOCKET_KEY_ENV.into(), "ab".repeat(32));
    assert!(maybe_start(home.path(), &mut env).await.unwrap().is_none());
    assert!(!env.contains_key(HOST_SOCKET_ENV));
    assert!(!env.contains_key(HOST_SOCKET_KEY_ENV));
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
    // Serve's env is also the native operations' env: the key is not in it.
    assert!(!env.contains_key(HOST_SOCKET_KEY_ENV));
    let key = guard.owner_key();
    let published = home.path().join("run").join(HOST_KEY_NAME);
    assert_eq!(fs::read_to_string(&published).unwrap().trim(), key);
    assert_eq!(
        fs::symlink_metadata(&published)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    guard.shutdown().await;
    assert!(!Path::new(&socket).exists());
    assert!(!sidecar.exists());
    assert!(!published.exists());
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deep_home_serve_binds_in_the_private_user_directory() {
    let root = tempfile::tempdir().unwrap();
    let home = deep_home(root.path());
    let mut env = HashMap::new();
    env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "1".into());
    let Some(base) = user_private_dir() else {
        // Linux without XDG_RUNTIME_DIR: serve refuses, never /tmp.
        let error = match maybe_start(&home, &mut env).await {
            Err(error) => error,
            Ok(_) => panic!("serve started without a per-user directory"),
        };
        assert!(
            error.to_string().contains("PACER_NATIVE_PLUGIN_HOST=0"),
            "{error}"
        );
        return;
    };
    let guard = maybe_start(&home, &mut env).await.unwrap().unwrap();
    let socket = Path::new(env.get(HOST_SOCKET_ENV).unwrap());
    let dir = socket.parent().unwrap();
    assert_eq!(dir.parent().unwrap(), base);
    assert!(
        dir.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("pacer-"),
        "{}",
        dir.display()
    );
    assert!(socket.as_os_str().len() <= SOCKET_PATH_MAX);
    assert_eq!(fs::metadata(dir).unwrap().mode() & 0o777, 0o700);
    assert_eq!(
        fs::symlink_metadata(socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // The lease and its sidecars follow the socket into the private directory.
    let pid = dir.join("host.sock.pid");
    assert_eq!(
        fs::read_to_string(&pid).unwrap().trim(),
        std::process::id().to_string()
    );
    assert_eq!(
        fs::symlink_metadata(&pid).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::read_to_string(dir.join(HOST_KEY_NAME)).unwrap().trim(),
        guard.owner_key()
    );
    // The deep home itself is never touched.
    assert!(!home.join("run").exists());
    guard.shutdown().await;
    assert!(!socket.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deep_home_second_serve_is_refused_with_the_private_lease() {
    let root = tempfile::tempdir().unwrap();
    let home = deep_home(root.path());
    let first = maybe_start(&home, &mut flag_on(0)).await.unwrap().unwrap();
    let error = match maybe_start(&home, &mut flag_on(600)).await {
        Err(error) => error,
        Ok(_) => panic!("a second deep-home owner started"),
    };
    assert_eq!(exit_code(&error), EXIT_HOME_OWNED);
    // The refusal names the bound socket and the pid read from the private dir.
    assert!(error.to_string().contains("host.sock"), "{error}");
    assert!(
        error
            .to_string()
            .contains(&format!("(pid {})", std::process::id())),
        "{error}"
    );
    first.shutdown().await;
}

#[test]
fn a_deep_home_serve_without_a_usable_private_dir_is_refused_with_the_escape_hatch() {
    let root = tempfile::tempdir().unwrap();
    let home = deep_home(root.path());
    let auth = PeerAuth::same_uid(OwnerKey::generate().unwrap());
    let result = ReverseBridge::bind_serve(&home, auth);
    let Some(base) = user_private_dir() else {
        // No per-user directory: the flag that runs a short home refuses here.
        let message = result.err().unwrap().to_string();
        assert!(message.contains("PACER_NATIVE_PLUGIN_HOST=0"), "{message}");
        assert!(message.contains("shorter PACER_HOME"), "{message}");
        return;
    };
    // A usable private directory lets the deep home bind there (0700 dir, 0600 socket).
    let bridge = result.unwrap();
    let socket = bridge.path().to_path_buf();
    let dir = socket.parent().unwrap().to_path_buf();
    assert_eq!(dir.parent().unwrap(), base);
    assert!(socket.as_os_str().len() <= SOCKET_PATH_MAX);
    assert_eq!(
        fs::symlink_metadata(&socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    drop(bridge);
    fs::remove_file(dir.join("host.sock")).ok();
    fs::remove_dir(dir).ok();
}
