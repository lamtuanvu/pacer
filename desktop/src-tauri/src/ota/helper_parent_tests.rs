use super::super::super::native::ProcessIdentity;
use super::*;

fn process(pid: u32, parent_pid: u32, executable: &str) -> ProcessDetails {
    ProcessDetails {
        identity: ProcessIdentity {
            pid,
            boot_id: "boot".into(),
            birth: format!("{pid}:1"),
        },
        executable: executable.into(),
        uid: 501,
        parent_pid,
    }
}
#[test]
fn paired_relationship_requires_exact_siblings_and_direct_same_uid_parent() {
    let front = process(10, 1, "/tmp/Pacer.app/Contents/Resources/pacer");
    let core = process(11, 10, "/tmp/Pacer.app/Contents/Resources/pacer-core");
    assert_eq!(
        paired_app(&front, &core, 501).unwrap(),
        PathBuf::from("/tmp/Pacer.app")
    );
    for field in 0..8 {
        let mut changed = core.clone();
        match field {
            0 => changed.parent_pid = 12,
            1 => changed.uid = 502,
            2 => changed.identity.boot_id = "other".into(),
            3 => changed.identity.birth.clear(),
            4 => changed.identity.pid = 10,
            5 => changed.executable = "/tmp/Other.app/Contents/Resources/pacer-core".into(),
            6 => changed.executable = "/tmp/Pacer.app/Contents/Resources/pacer".into(),
            _ => {
                changed.executable =
                    "/tmp/Pacer.app/Contents/Resources/../Resources/pacer-core".into()
            }
        }
        assert!(paired_app(&front, &changed, 501).is_err(), "field {field}");
    }
    for path in [
        "/tmp/pacer",
        "/tmp/Pacer/Contents/Resources/pacer",
        "/tmp/AppTranslocation/Pacer.app/Contents/Resources/pacer",
        "/tmp/Pacer.app/Contents/Resources//pacer",
    ] {
        let mut changed = front.clone();
        changed.executable = path.into();
        assert!(paired_app(&changed, &core, 501).is_err(), "{path}");
    }
}

#[test]
fn paired_declaration_requires_release_version_arch_and_native_compatibility() {
    let metadata = serde_json::json!({"schema":1,"bundleId":"dev.pacer.desktop",
        "version":"1.2.3","arch":std::env::consts::ARCH,"cliLayout":"paired",
        "admissionProtocol":1,"nativeTransportAbi":1,"rollbackCompatible":true,"protocolMajors":[3]});
    paired_metadata(&metadata, "1.2.3").unwrap();
    for majors in [
        serde_json::json!([3, 0]),
        serde_json::json!([3, "bad"]),
        serde_json::json!([3, -1]),
    ] {
        let mut changed = metadata.clone();
        changed["protocolMajors"] = majors;
        assert!(paired_metadata(&changed, "1.2.3").is_err());
    }
    assert!(paired_metadata(&metadata, "1.2.4").is_err());
    for (key, value) in [
        ("schema", serde_json::json!(2)),
        ("bundleId", serde_json::json!("other")),
        ("cliLayout", serde_json::json!("legacy")),
        ("arch", serde_json::json!("other")),
        ("admissionProtocol", serde_json::json!(2)),
        ("nativeTransportAbi", serde_json::json!(2)),
        ("rollbackCompatible", serde_json::json!(false)),
        ("protocolMajors", serde_json::json!([2])),
    ] {
        let mut changed = metadata.clone();
        changed[key] = value;
        assert!(paired_metadata(&changed, "1.2.3").is_err(), "{key}");
        changed.as_object_mut().unwrap().remove(key);
        assert!(paired_metadata(&changed, "1.2.3").is_err(), "missing {key}");
    }
}
