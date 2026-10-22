#![allow(clippy::unwrap_used)]
use super::*;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
fn process() -> ProcessIdentity {
    super::super::native_trust::process_details(std::process::id())
        .unwrap()
        .process
}
#[test]
fn owns_socket_and_exact_owner_record() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("native.sock");
    let listener = NativeListener::bind_at(path.clone(), &process()).unwrap();
    assert_eq!(
        listener.listener.local_addr().unwrap().as_pathname(),
        Some(path.as_path())
    );
    assert_eq!(path.symlink_metadata().unwrap().mode() & 0o777, 0o600);
    let record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path.with_extension("sock.owner")).unwrap()).unwrap();
    assert_eq!(record["process"]["pid"], std::process::id());
    assert_eq!(record["inode"], path.symlink_metadata().unwrap().ino());
    drop(listener);
    assert!(!path.exists());
    assert!(!path.with_extension("sock.owner").exists());
}
#[test]
fn never_removes_replacement_socket_or_owner() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("native.sock");
    let listener = NativeListener::bind_at(path.clone(), &process()).unwrap();
    std::fs::rename(&path, directory.path().join("original.sock")).unwrap();
    let replacement = UnixListener::bind(&path).unwrap();
    let owner = path.with_extension("sock.owner");
    std::fs::rename(&owner, directory.path().join("original.owner")).unwrap();
    std::fs::write(&owner, b"replacement").unwrap();
    drop(listener);
    assert!(path.exists());
    assert_eq!(std::fs::read(&owner).unwrap(), b"replacement");
    drop(replacement);
}
#[test]
fn refuses_unknown_existing_socket_and_broad_directory() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("native.sock");
    let existing = UnixListener::bind(&path).unwrap();
    assert!(NativeListener::bind_at(path.clone(), &process()).is_err());
    assert!(path.exists());
    drop(existing);
    std::fs::remove_file(&path).unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(NativeListener::bind_at(path.clone(), &process()).is_err());
    assert!(!path.exists());
}
#[test]
fn reclaims_dead_owner_but_never_a_live_listener_with_forged_dead_owner() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("native.sock");
    let old = UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let owner = path.with_extension("sock.owner");
    let own = process();
    let record = serde_json::json!({"process":{"pid":own.pid,"bootId":own.boot_id,"birth":"1:0"},"inode":path.symlink_metadata().unwrap().ino()});
    std::fs::write(&owner, serde_json::to_vec(&record).unwrap()).unwrap();
    std::fs::set_permissions(&owner, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(NativeListener::bind_at(path.clone(), &process()).is_err());
    drop(old);
    let replacement = NativeListener::bind_at(path.clone(), &process()).unwrap();
    drop(replacement);
}
#[test]
fn namespace_matches_existing_native_transport_and_rejects_zero_port() {
    assert_eq!(
        socket_path(Path::new("/private/tmp"), 4317, 501).unwrap(),
        PathBuf::from("/private/tmp/pacer-native-501/c7df85def5b45c73fcd81777a39fefcc.sock")
    );
    assert!(socket_path(Path::new("/private/tmp"), 0, 501).is_err());
}
#[test]
fn cleanup_does_not_follow_replaced_parent_directory() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("private");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = parent.join("native.sock");
    let listener = NativeListener::bind_at(path.clone(), &process()).unwrap();
    let original = root.path().join("original");
    std::fs::rename(&parent, &original).unwrap();
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let replacement = UnixListener::bind(&path).unwrap();
    std::fs::write(path.with_extension("sock.owner"), b"replacement").unwrap();
    drop(listener);
    assert!(path.exists());
    assert!(original.join("native.sock").exists());
    assert_eq!(
        std::fs::read(path.with_extension("sock.owner")).unwrap(),
        b"replacement"
    );
    drop(replacement);
}
#[test]
fn owner_only_and_redirected_owner_records_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.path().join("native.sock");
    let owner = path.with_extension("sock.owner");
    std::fs::write(&owner, b"unknown").unwrap();
    assert!(NativeListener::bind_at(path.clone(), &process()).is_err());
    assert!(!path.exists());
    std::fs::remove_file(&owner).unwrap();
    let old = UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let target = root.path().join("target");
    std::fs::write(&target, b"untouched").unwrap();
    std::os::unix::fs::symlink(&target, &owner).unwrap();
    assert!(NativeListener::bind_at(path.clone(), &process()).is_err());
    assert!(path.exists());
    assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    drop(old);
}
