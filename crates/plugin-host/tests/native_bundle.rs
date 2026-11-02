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
#[tokio::test]
async fn cancelled_stage_is_owned_until_child_and_private_bytes_are_settled() {
    let home = std::env::temp_dir().join(format!("pacer-cancel-bundle-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let argv = vec!["ssh".into(), "-c".into(), "printf partial; sleep 10".into()];
    let mut bundle = NativeBundle::prepare(
        &home,
        BundleSpec {
            argv: argv.clone(),
            executable: "/bin/sh".into(),
            env: HashMap::new(),
            timeout_ms: 1000,
            max_bytes: 1024,
        },
    )
    .unwrap();
    let request = json!({"argv":argv,"timeoutMs":1000,"maxBytes":1024});
    {
        let pending = bundle.stage(&request, Instant::now() + Duration::from_secs(5));
        tokio::pin!(pending);
        tokio::select! {result=&mut pending=>panic!("unexpected early stage {result:?}"),_=async{loop{if fs::read_dir(home.join("transfers")).unwrap().filter_map(Result::ok).any(|e|fs::metadata(e.path().join("out.bundle")).is_ok_and(|m|m.len()>0)){break;}tokio::time::sleep(Duration::from_millis(5)).await;}}=>{}}
    }
    bundle.retire_owned().await.unwrap();
    assert_eq!(fs::read_dir(home.join("transfers")).unwrap().count(), 0);
    fs::remove_dir_all(home).unwrap();
}
#[tokio::test]
async fn ticket_discard_never_removes_a_replacement_directory_and_failure_sticks() {
    let home = std::env::temp_dir().join(format!("pacer-foreign-bundle-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let argv = vec!["ssh".into(), "owned".into()];
    let mut bundle = NativeBundle::prepare(
        &home,
        BundleSpec {
            argv: argv.clone(),
            executable: "/usr/bin/printf".into(),
            env: HashMap::new(),
            timeout_ms: 1000,
            max_bytes: 1024,
        },
    )
    .unwrap();
    bundle
        .stage(
            &json!({"argv":argv,"timeoutMs":1000,"maxBytes":1024}),
            Instant::now() + Duration::from_secs(3),
        )
        .await
        .unwrap();
    let stage = fs::read_dir(home.join("transfers"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::rename(&stage, home.join("held")).unwrap();
    fs::create_dir(&stage).unwrap();
    assert!(bundle.retire_owned().await.is_err());
    assert!(stage.is_dir());
    assert!(bundle.retire_owned().await.is_err());
    assert!(stage.is_dir());
    fs::remove_dir_all(home).unwrap();
}
