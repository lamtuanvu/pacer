#![allow(clippy::unwrap_used)]
use super::*;
use crate::{NativeWrite, SpawnCapture, WriteResource};

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn capture_after_the_call_deadline_never_publishes() {
    let root = Root(std::env::temp_dir().join(format!("pacer-capture-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&root.0).unwrap();
    let path = |name: &str| root.0.join(name).to_string_lossy().into_owned();
    let resource = |name| WriteResource {
        path: path(name),
        kind: "file".into(),
        operations: vec!["write".into()],
    };
    let mut capture = NativeWrite::prepare(&root.0, &[resource("out"), resource("err")]).unwrap();
    let paths = SpawnCapture {
        stdout: path("out"),
        stderr: path("err"),
    };
    let expired = publish_capture(&mut capture, &paths, [b"late", b"late"], Instant::now());
    assert!(matches!(
        expired,
        Err(BrokerError::Authority(AuthorityError::Expired))
    ));
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    let live = Instant::now() + Duration::from_secs(5);
    publish_capture(&mut capture, &paths, [b"out", b"err"], live).unwrap();
    assert_eq!(fs::read(root.0.join("out")).unwrap(), b"out");
    assert_eq!(fs::read(root.0.join("err")).unwrap(), b"err");
}
