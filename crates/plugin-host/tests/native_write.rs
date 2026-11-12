#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{NativeWrite, WriteResource};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("pacer-native-write-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn path(&self, p: &str) -> String {
        self.0.join(p).to_str().unwrap().into()
    }
    fn resource(&self, p: &str, kind: &str) -> WriteResource {
        WriteResource {
            path: self.path(p),
            kind: kind.into(),
            operations: vec!["write".into(), "mkdir".into(), "remove".into()],
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn atomic_private_write_noop_mkdir_remove_and_exact_resources() {
    let f = Fixture::new();
    let mut native = NativeWrite::prepare(
        &f.0,
        &[
            f.resource("dir", "directory"),
            f.resource("dir/file", "file"),
        ],
    )
    .unwrap();
    native
        .answer("capability.fs.mkdir", &json!({"path":f.path("dir")}))
        .unwrap();
    native
        .answer(
            "capability.fs.write",
            &json!({"path":f.path("dir/file"),"text":"界\u{feff}"}),
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(f.path("dir/file")).unwrap(),
        "界\u{feff}"
    );
    assert_eq!(
        fs::metadata(f.path("dir")).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(f.path("dir/file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(
        native
            .answer(
                "capability.fs.write",
                &json!({"path":f.path("other"),"text":"bad"})
            )
            .is_err()
    );
    native
        .answer("capability.fs.remove", &json!({"path":f.path("dir/file")}))
        .unwrap();
    native
        .answer("capability.fs.remove", &json!({"path":f.path("dir")}))
        .unwrap();
    assert!(!f.0.join("dir").exists());
}

#[test]
fn refuses_symlinks_hardlinks_and_parent_or_target_replacement() {
    let f = Fixture::new();
    fs::write(f.path("victim"), "victim").unwrap();
    symlink(f.path("victim"), f.path("file")).unwrap();
    assert!(NativeWrite::prepare(&f.0, &[f.resource("file", "file")]).is_err());
    fs::remove_file(f.path("file")).unwrap();
    fs::hard_link(f.path("victim"), f.path("file")).unwrap();
    assert!(NativeWrite::prepare(&f.0, &[f.resource("file", "file")]).is_err());
    fs::remove_file(f.path("file")).unwrap();
    fs::create_dir(f.path("dir")).unwrap();
    let mut native = NativeWrite::prepare(&f.0, &[f.resource("dir/file", "file")]).unwrap();
    fs::rename(f.path("dir"), f.path("moved")).unwrap();
    symlink(&f.0, f.path("dir")).unwrap();
    assert!(
        native
            .answer(
                "capability.fs.write",
                &json!({"path":f.path("dir/file"),"text":"bad"})
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(f.path("victim")).unwrap(), "victim");
    let mut native = NativeWrite::prepare(&f.0, &[f.resource("file", "file")]).unwrap();
    fs::write(f.path("file"), "unissued").unwrap();
    assert!(
        native
            .answer(
                "capability.fs.write",
                &json!({"path":f.path("file"),"text":"bad"})
            )
            .is_err()
    );
}

#[test]
fn exact_utf8_limit_and_modes_precede_staging() {
    let f = Fixture::new();
    let mut native = NativeWrite::prepare(&f.0, &[f.resource("file", "file")]).unwrap();
    let text = "界".repeat(1_398_101) + "a";
    native
        .answer(
            "capability.fs.write",
            &json!({"path":f.path("file"),"text":text}),
        )
        .unwrap();
    assert_eq!(fs::metadata(f.path("file")).unwrap().len(), 4_194_304);
    assert!(
        native
            .answer(
                "capability.fs.write",
                &json!({"path":f.path("file"),"text":text+"a"})
            )
            .is_err()
    );
    assert!(
        native
            .answer(
                "capability.fs.write",
                &json!({"path":f.path("file"),"text":"x","mode":420})
            )
            .is_err()
    );
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
}

#[test]
fn identical_bytes_preserve_inode_and_mtime_while_repairing_private_mode() {
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::new();
    let mut native = NativeWrite::prepare(&f.0, &[f.resource("file", "file")]).unwrap();
    native.write_bytes(&f.path("file"), b"same").unwrap();
    let before = fs::metadata(f.path("file")).unwrap();
    fs::set_permissions(f.path("file"), fs::Permissions::from_mode(0o644)).unwrap();
    native.write_bytes(&f.path("file"), b"same").unwrap();
    let after = fs::metadata(f.path("file")).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(before.mtime(), after.mtime());
    assert_eq!(before.mtime_nsec(), after.mtime_nsec());
    assert_eq!(after.permissions().mode() & 0o777, 0o600);
}

#[test]
fn recursive_remove_never_follows_a_descendant_symlink() {
    let f = Fixture::new();
    fs::create_dir(f.path("dir")).unwrap();
    fs::write(f.path("victim"), "outside").unwrap();
    symlink(f.path("victim"), f.path("dir/link")).unwrap();
    let mut native = NativeWrite::prepare(&f.0, &[f.resource("dir", "directory")]).unwrap();
    assert!(
        native
            .answer(
                "capability.fs.remove",
                &json!({"path":f.path("dir"),"recursive":true})
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(f.path("victim")).unwrap(), "outside");
    assert!(
        fs::symlink_metadata(f.path("dir/link"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
