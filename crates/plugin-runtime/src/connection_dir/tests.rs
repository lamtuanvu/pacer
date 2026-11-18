#![allow(clippy::unwrap_used)]
use super::*;
use nix::sys::{stat::lutimes, time::TimeVal};
use std::os::unix::{fs::PermissionsExt, net::UnixListener};

fn me() -> u32 {
    nix::unistd::getuid().as_raw()
}

/// A private directory short enough for socket paths.
fn short_dir() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("pcd-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    dir
}

/// A home whose `run/s<12-hex>.sock` cannot fit in `sockaddr_un`.
fn deep_home(root: &Path) -> PathBuf {
    root.join("d".repeat(SOCKET_PATH_MAX))
}

const NAME: &str = "s0123456789ab.sock";

fn refusal(result: Result<PathBuf, BridgeError>) -> String {
    match result {
        Err(error @ BridgeError::NoPrivateDir { .. }) => error.to_string(),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// Bound more than [`STALE_AFTER`] ago, without following a symlink.
fn age(path: &Path) {
    let then = TimeVal::new(1_000_000_000, 0);
    lutimes(path, &then, &then).unwrap();
}

/// A socket file nobody listens on any more.
fn stale_socket(path: &Path) {
    drop(UnixListener::bind(path).unwrap());
}

#[test]
fn normal_homes_keep_the_run_directory() {
    let home = short_dir();
    let dir = connection_socket_dir(home.path(), NAME, me()).unwrap();
    assert_eq!(dir, home.path().join("run"));
    assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
}

#[test]
fn a_deep_home_gets_a_private_directory_under_the_user_base() {
    let base = short_dir();
    let home = deep_home(base.path());
    let dir = private_socket_dir(&home, Ok(base.path().into()), NAME, me()).unwrap();
    let name = dir.file_name().unwrap().to_str().unwrap();
    assert_eq!(dir.parent().unwrap(), base.path());
    assert!(name.starts_with("pacer-") && name.len() == 22, "{name}");
    assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
    // The same home always maps to the same directory; another home does not.
    assert_eq!(
        private_socket_dir(&home, Ok(base.path().into()), NAME, me()).unwrap(),
        dir
    );
    let other = private_socket_dir(&home.join("x"), Ok(base.path().into()), NAME, me());
    assert_ne!(other.unwrap(), dir);
    assert!(!home.exists(), "the deep home is never touched");
}

#[test]
fn an_unusable_user_base_is_refused_with_the_escape_hatches() {
    let root = short_dir();
    let home = deep_home(root.path());
    let message = refusal(private_socket_dir(&home, Err("unset".into()), NAME, me()));
    assert!(message.contains("unset"), "{message}");
    assert!(message.contains("PACER_NATIVE_PLUGIN_HOST=0"), "{message}");
    assert!(message.contains("shorter PACER_HOME"), "{message}");

    let real = root.path().join("real");
    fs::DirBuilder::new().mode(0o700).create(&real).unwrap();
    let link = root.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let file = root.path().join("file");
    fs::write(&file, "").unwrap();
    let open = root.path().join("open");
    fs::create_dir(&open).unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o750)).unwrap();
    for (base, uid, problem) in [
        (&link, me(), "is a symlink"),
        (&file, me(), "is not a directory"),
        (&real, me().wrapping_add(1), "belongs to another user"),
        (&open, me(), "is open to other users"),
    ] {
        let message = refusal(private_socket_dir(&home, Ok(base.clone()), NAME, uid));
        assert!(message.contains(problem), "{message}");
    }
    assert_eq!(fs::read_dir(&real).unwrap().count(), 0);
}

#[test]
fn a_planted_or_open_home_directory_is_refused() {
    let base = short_dir();
    let home = deep_home(base.path());
    let dir = private_socket_dir(&home, Ok(base.path().into()), NAME, me()).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o711)).unwrap();
    let message = refusal(private_socket_dir(
        &home,
        Ok(base.path().into()),
        NAME,
        me(),
    ));
    assert!(message.contains("is open to other users"), "{message}");

    fs::remove_dir(&dir).unwrap();
    let elsewhere = short_dir();
    std::os::unix::fs::symlink(elsewhere.path(), &dir).unwrap();
    let message = refusal(private_socket_dir(
        &home,
        Ok(base.path().into()),
        NAME,
        me(),
    ));
    assert!(message.contains("is a symlink"), "{message}");
}

#[test]
fn a_base_too_long_for_a_socket_is_refused() {
    let root = short_dir();
    let base = root.path().join("b".repeat(80));
    fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
    let message = refusal(private_socket_dir(
        &deep_home(root.path()),
        Ok(base),
        NAME,
        me(),
    ));
    assert!(message.contains("too long"), "{message}");
}

#[test]
fn the_sweep_removes_only_old_refusing_same_user_connection_sockets() {
    let dir = short_dir();
    let at = |name: &str| dir.path().join(name);
    stale_socket(&at("s000000000001.sock"));
    age(&at("s000000000001.sock"));
    // Possibly another connection between bind and listen.
    stale_socket(&at("s000000000002.sock"));
    let _live = UnixListener::bind(at("s000000000003.sock")).unwrap();
    age(&at("s000000000003.sock"));
    fs::write(at("s000000000004.sock"), "").unwrap();
    age(&at("s000000000004.sock"));
    let target = short_dir();
    stale_socket(&target.path().join("t.sock"));
    std::os::unix::fs::symlink(target.path().join("t.sock"), at("s000000000005.sock")).unwrap();
    age(&at("s000000000005.sock"));
    stale_socket(&at("host.sock"));
    age(&at("host.sock"));

    // Another user's view of the same directory removes nothing.
    assert_eq!(sweep_stale_sockets(dir.path(), me().wrapping_add(1)), 0);
    assert_eq!(sweep_stale_sockets(dir.path(), me()), 1);
    let mut left = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    left.sort();
    assert_eq!(
        left,
        [
            "host.sock",
            "s000000000002.sock",
            "s000000000003.sock",
            "s000000000004.sock",
            "s000000000005.sock"
        ]
    );
    assert!(target.path().join("t.sock").exists());
}

#[test]
fn a_base_under_an_open_non_sticky_ancestor_is_refused() {
    let root = short_dir();
    let open = root.path().join("open");
    let base = open.join("base");
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&base)
        .unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();
    let home = deep_home(root.path());
    let message = refusal(private_socket_dir(&home, Ok(base.clone()), NAME, me()));
    assert!(message.contains("without the sticky bit"), "{message}");
    assert_eq!(fs::read_dir(&base).unwrap().count(), 0);
    // A sticky shared directory (as /tmp) cannot have our entries renamed away.
    fs::set_permissions(&open, fs::Permissions::from_mode(0o1777)).unwrap();
    assert!(private_socket_dir(&home, Ok(base), NAME, me()).is_ok());
}

#[test]
fn the_probe_tells_live_refused_and_missing_sockets_apart() {
    let dir = short_dir();
    let live = dir.path().join("live.sock");
    let _listener = UnixListener::bind(&live).unwrap();
    assert_eq!(probe_socket(&live), Probe::Live);
    let stale = dir.path().join("stale.sock");
    stale_socket(&stale);
    assert_eq!(probe_socket(&stale), Probe::Refused);
    assert_eq!(probe_socket(&dir.path().join("none.sock")), Probe::Missing);
}

#[test]
fn only_connection_socket_names_are_swept() {
    assert!(is_connection_socket_name("s0123456789ab.sock"));
    for name in [
        "host.sock",
        "s0123456789AB.sock",
        "s0123456789a.sock",
        "x0123456789ab.sock",
    ] {
        assert!(!is_connection_socket_name(name), "{name}");
    }
}
