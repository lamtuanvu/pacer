#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{BundleSpec, NativeBundle};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};
#[tokio::test]
async fn bundle_is_bounded_private_one_use_and_returns_only_an_opaque_handle() {
    let home = std::env::temp_dir().join(format!("pacer-bundle-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let spec = BundleSpec {
        argv: vec!["ssh".into(), "synthetic-bundle".into()],
        executable: "/usr/bin/printf".into(),
        env: HashMap::new(),
        timeout_ms: 1000,
        max_bytes: 1024,
    };
    let mut stage = NativeBundle::prepare(&home, spec).unwrap();
    let request = json!({"argv":["ssh","synthetic-bundle"],"timeoutMs":1000,"maxBytes":1024});
    let result = stage
        .stage(&request, Instant::now() + Duration::from_secs(3))
        .await
        .unwrap();
    assert_eq!(result["bytes"], 16);
    assert_eq!(result.as_object().unwrap().len(), 3);
    let handle = result["handle"].as_str().unwrap();
    let mut ticket = stage.claim(handle).unwrap();
    assert_eq!(ticket.read().unwrap(), b"synthetic-bundle");
    assert!(stage.claim(handle).is_err());
    assert!(
        stage
            .stage(&request, Instant::now() + Duration::from_secs(3))
            .await
            .is_err()
    );
    drop(ticket);
    drop(stage);
    assert_eq!(fs::read_dir(home.join("transfers")).unwrap().count(), 0);
    fs::remove_dir_all(home).unwrap();
}
