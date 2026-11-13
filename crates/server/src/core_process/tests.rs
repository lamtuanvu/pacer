#![allow(clippy::unwrap_used)]

use super::*;
use pacer_plugin_runtime::{HOST_SOCKET_ENV, OwnerKey};

fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

fn keys(env: &Env) -> Vec<&OsStr> {
    env.keys().map(OsString::as_os_str).collect()
}

/// Every key Core consumes at startup, including the owner credential.
fn consumed() -> Vec<(&'static str, &'static str)> {
    [
        "PACER_HOST_SOCKET_KEY",
        "PACER_INTERNAL_NATIVE_BOOTSTRAP",
        "PACER_INTERNAL_TOKEN",
        "PACER_NATIVE_CONFIG_SYNC_KEY",
    ]
    .into_iter()
    .map(|key| (key, "secret"))
    .collect()
}

#[test]
fn serve_records_the_core_child_env_without_consumed_keys_or_bun_options() {
    let mut pairs = consumed();
    pairs.extend([
        ("PATH", "/usr/bin"),
        ("BUN_OPTIONS", "--inspect"),
        ("NODE_OPTIONS", "--require x"),
        (HOST_SOCKET_ENV, "/tmp/host.sock"),
    ]);
    let env = serve_env(&map(&pairs));
    assert_eq!(
        keys(&env),
        ["PACER_HOST_SOCKET", "PACER_INTERNAL_PARENT_PIPE", "PATH"]
    );
    assert_eq!(env[OsStr::new("PACER_INTERNAL_PARENT_PIPE")], "1");
    assert_eq!(env[OsStr::new(HOST_SOCKET_ENV)], "/tmp/host.sock");
}

#[test]
fn stdio_records_inherited_then_child_env_without_consumed_keys() {
    let mut inherited = consumed();
    inherited.extend([("PATH", "/inherited"), ("HOME", "/home")]);
    let mut child = consumed();
    child.push(("PATH", "/child"));
    let env = stdio_env(os(&inherited), &map(&child), &HostSocket::Inherit);
    assert_eq!(keys(&env), ["HOME", "PATH"]);
    assert_eq!(env[OsStr::new("PATH")], "/child");
}

#[test]
fn stdio_applies_the_host_socket_decision() {
    let inherited = os(&[(HOST_SOCKET_ENV, "/inherited.sock"), ("HOME", "/home")]);
    let socket = |decision: &HostSocket| {
        stdio_env(inherited.clone(), &HashMap::new(), decision)
            .get(OsStr::new(HOST_SOCKET_ENV))
            .cloned()
    };
    assert_eq!(socket(&HostSocket::Inherit), Some("/inherited.sock".into()));
    assert_eq!(socket(&HostSocket::Unset), None);
    assert_eq!(
        socket(&HostSocket::Set(
            "/owned.sock".into(),
            OwnerKey::generate().unwrap()
        )),
        Some("/owned.sock".into())
    );
    let set = stdio_env(
        inherited.clone(),
        &HashMap::new(),
        &HostSocket::Set("/owned.sock".into(), OwnerKey::generate().unwrap()),
    );
    assert!(!set.contains_key(OsStr::new("PACER_HOST_SOCKET_KEY")));
}
