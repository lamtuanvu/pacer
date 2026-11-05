#![allow(clippy::unwrap_used)]
use pacer_plugin_runtime::{
    HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND, OwnerError,
    Ownership, ProcessOwner, host_socket_path, prepare_host_run_dir,
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
    assert_eq!(
        owner.claim_native_supervision(),
        Err(OwnerError::NativeNotActivated)
    );
}

#[test]
fn reverse_bridge_contract_names_match_design() {
    assert_eq!(HOST_SOCKET_ENV, "PACER_HOST_SOCKET");
    assert_eq!(HOST_SOCKET_NAME, "host.sock");
    assert_eq!(METHOD_PLUGIN_CALL, "_host.plugin.call");
    assert_eq!(METHOD_PLUGIN_FIND, "_host.plugin.find");
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
