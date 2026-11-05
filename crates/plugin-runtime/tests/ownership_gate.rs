#![allow(clippy::unwrap_used)]
use pacer_plugin_runtime::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL,
    METHOD_PLUGIN_FIND, NATIVE_PLUGIN_HOST_ENABLE_ENV, OwnerError, Ownership, ProcessOwner,
    dark_bridge_enabled, host_socket_path, native_plugin_host_enabled, prepare_host_run_dir,
    serve_starts_reverse_bridge_by_default,
};
use std::{fs, os::unix::fs::MetadataExt, path::Path};

#[test]
fn production_owner_refuses_native_claim() {
    let owner = ProcessOwner::typescript();
    assert!(!owner.ownership().is_native());
    assert_eq!(
        owner.claim_native_supervision(),
        Err(OwnerError::TypeScriptOwnsHost)
    );
    assert_eq!(
        ProcessOwner::default().ownership(),
        &Ownership::typescript()
    );
}

#[test]
fn test_native_token_still_blocks_serve_activation() {
    let owner = ProcessOwner::native_for_tests();
    assert!(owner.ownership().is_native());
    assert!(!owner.ownership().supervision_claimed());
    assert_eq!(
        owner.claim_native_supervision(),
        Err(OwnerError::NativeNotActivated)
    );
}

#[test]
fn serve_native_owner_claims_supervision() {
    let owner = ProcessOwner::native_for_serve();
    assert!(owner.ownership().is_native());
    assert!(owner.ownership().supervision_claimed());
    assert_eq!(owner.claim_native_supervision(), Ok(()));
}

#[test]
fn reverse_bridge_contract_names_match_design() {
    assert_eq!(HOST_SOCKET_ENV, "PACER_HOST_SOCKET");
    assert_eq!(HOST_BRIDGE_ENABLE_ENV, "PACER_HOST_BRIDGE");
    assert_eq!(NATIVE_PLUGIN_HOST_ENABLE_ENV, "PACER_NATIVE_PLUGIN_HOST");
    assert_eq!(HOST_SOCKET_NAME, "host.sock");
    assert_eq!(METHOD_PLUGIN_CALL, "_host.plugin.call");
    assert_eq!(METHOD_PLUGIN_FIND, "_host.plugin.find");
    assert_eq!(
        pacer_plugin_runtime::METHOD_PLUGIN_SPAWN,
        "_host.plugin.spawn"
    );
    assert_eq!(
        pacer_plugin_runtime::METHOD_PLUGIN_STOP,
        "_host.plugin.stop"
    );
    assert!(!serve_starts_reverse_bridge_by_default());
    assert!(!dark_bridge_enabled(None));
    assert!(dark_bridge_enabled(Some("1")));
    assert!(!native_plugin_host_enabled(None, None));
    assert!(native_plugin_host_enabled(Some("1"), None));
    assert!(native_plugin_host_enabled(None, Some("1")));
    let home = Path::new("/tmp/pacer-home-example");
    assert_eq!(
        host_socket_path(home),
        home.join("run").join(HOST_SOCKET_NAME)
    );
}

#[test]
fn prepare_host_run_dir_is_mode_0700_without_listening() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let socket = prepare_host_run_dir(&home).unwrap();
    assert_eq!(socket, home.join("run").join("host.sock"));
    assert!(!socket.exists(), "scaffold must not create the socket yet");
    let meta = fs::symlink_metadata(home.join("run")).unwrap();
    assert!(meta.is_dir());
    assert_eq!(meta.mode() & 0o777, 0o700);
    // Idempotent on an existing real directory.
    assert_eq!(prepare_host_run_dir(&home).unwrap(), socket);
}
