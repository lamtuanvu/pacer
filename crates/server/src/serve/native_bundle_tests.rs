#![allow(clippy::unwrap_used)]
use super::*;
use crate::serve::native_trust::ProcessIdentity;

#[test]
fn metadata_read_is_bounded_regular_owned_and_not_redirected() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("metadata.json");
    std::fs::write(&path, br#"{"schema":1}"#).unwrap();
    assert_eq!(owned_json(&path).unwrap(), serde_json::json!({"schema":1}));
    let alias = dir.path().join("alias");
    symlink(&path, &alias).unwrap();
    assert!(owned_json(&alias).is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(owned_json(&path).is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = dir.path().join("hardlink");
    std::fs::hard_link(&path, &link).unwrap();
    assert!(owned_json(&path).is_err());
    std::fs::remove_file(link).unwrap();
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({"large":"x".repeat(65537)})).unwrap(),
    )
    .unwrap();
    assert!(owned_json(&path).is_err());
    assert!(owned_json(dir.path()).is_err());
    assert!(owned_json(&dir.path().join("missing")).is_err());
}

fn proof() -> (ProcessDetails, serde_json::Value) {
    (
        ProcessDetails {
            process: ProcessIdentity {
                pid: 201,
                boot_id: "boot".into(),
                birth: "1:0".into(),
            },
            uid: nix::unistd::getuid().as_raw(),
            parent_pid: 1,
            executable: "/Applications/pacer.app/Contents/Resources/pacer".into(),
        },
        serde_json::json!({"schema":1,"bundleId":"dev.pacer.desktop","version":"1.2.3",
        "arch":std::env::consts::ARCH,"protocolMajors":[3],"admissionProtocol":1,
        "nativeTransportAbi":1,"rollbackCompatible":true,"cliLayout":"paired"}),
    )
}
#[test]
fn layout_binds_the_actual_front_door_version_and_fixed_sibling_core() {
    let (owner, metadata) = proof();
    let layout = paired_layout(&owner, "1.2.3", &metadata).unwrap();
    assert_eq!(layout.app, PathBuf::from("/Applications/pacer.app"));
    assert_eq!(layout.front, owner.executable);
    assert_eq!(
        layout.core,
        PathBuf::from("/Applications/pacer.app/Contents/Resources/pacer-core")
    );
    assert_eq!(layout.owner, owner.process);
    assert_eq!(layout.version, "1.2.3");
}
#[test]
fn mismatched_or_missing_sealed_metadata_cannot_enable_native_layout() {
    for (key, value) in [
        ("schema", serde_json::json!(2)),
        ("bundleId", serde_json::json!("other")),
        ("version", serde_json::json!("1.2.4")),
        ("arch", serde_json::json!("universal")),
        ("protocolMajors", serde_json::json!([2])),
        ("admissionProtocol", serde_json::json!(0)),
        ("nativeTransportAbi", serde_json::json!(2)),
        ("rollbackCompatible", serde_json::json!(false)),
        ("cliLayout", serde_json::Value::Null),
        ("cliLayout", serde_json::json!("legacy")),
    ] {
        let (owner, mut metadata) = proof();
        metadata[key] = value;
        assert!(paired_layout(&owner, "1.2.3", &metadata).is_err(), "{key}");
    }
    let (owner, metadata) = proof();
    assert!(paired_layout(&owner, "1.2.4", &metadata).is_err());
    assert!(paired_layout(&owner, "1.2.3", &serde_json::json!({})).is_err());
}
#[test]
fn detached_redirected_or_translocated_front_doors_are_not_paired_apps() {
    for path in [
        "/opt/pacer",
        "/Applications/pacer.app/Contents/MacOS/pacer",
        "/Applications/pacer.app/Contents/Resources/pacer-core",
        "/Applications/pacer.app/Contents/Resources/../Resources/pacer",
        "/Applications/pacer.app/Contents/Resources/./pacer",
        "/Applications/pacer.app/Contents//Resources/pacer",
        "/private/AppTranslocation/pacer.app/Contents/Resources/pacer",
    ] {
        let (mut owner, metadata) = proof();
        owner.executable = path.into();
        assert!(paired_layout(&owner, "1.2.3", &metadata).is_err(), "{path}");
    }
    let (mut owner, metadata) = proof();
    owner.uid += 1;
    assert!(paired_layout(&owner, "1.2.3", &metadata).is_err());
}
