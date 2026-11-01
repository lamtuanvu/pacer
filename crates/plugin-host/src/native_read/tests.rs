#![allow(clippy::unwrap_used)]
use super::*;
use std::os::unix::fs::symlink;

#[test]
fn exact_file_range_and_changed_name() {
    let root = std::env::temp_dir().join(format!("pacer-native-read-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("telemetry.json");
    fs::write(&path, b"abc\xff").unwrap();
    let resource = ReadResource {
        path: path.to_str().unwrap().into(),
        kind: "file".into(),
    };
    let mut reader = NativeRead::prepare(&[resource]).unwrap();
    let stat = reader
        .answer("capability.fs.stat", &json!({"path":path}))
        .unwrap();
    let expected = stat["info"].clone();
    let ranged = reader
        .answer(
            "capability.fs.readRange",
            &json!({"path":path,"offset":1,"length":3,"expected":expected}),
        )
        .unwrap();
    assert_eq!(ranged["base64"], "YmP/");
    assert!(
        reader
            .answer(
                "capability.fs.readRange",
                &json!({"path":path,"offset":0,"length":1,"expected":{"size":0}})
            )
            .is_err()
    );
    fs::rename(&path, root.join("old")).unwrap();
    symlink(root.join("old"), &path).unwrap();
    assert!(
        reader
            .answer("capability.fs.read", &json!({"path":path}))
            .is_err()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn new_file_under_issued_root_is_readable_but_new_root_is_not() {
    let root = std::env::temp_dir().join(format!("pacer-native-read-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("later");
    let resource = ReadResource {
        path: path.to_str().unwrap().into(),
        kind: "file".into(),
    };
    let mut reader = NativeRead::prepare(&[resource]).unwrap();
    assert_eq!(
        reader
            .answer("capability.fs.read", &json!({"path":path}))
            .unwrap(),
        json!({"missing":true})
    );
    fs::write(&path, "created").unwrap();
    assert_eq!(
        reader
            .answer("capability.fs.read", &json!({"path":path}))
            .unwrap()["text"],
        "created"
    );
    let absent = root.join("new-root").join("later");
    let mut missing_root = NativeRead::prepare(&[ReadResource {
        path: absent.to_str().unwrap().into(),
        kind: "file".into(),
    }])
    .unwrap();
    fs::create_dir(root.join("new-root")).unwrap();
    fs::write(&absent, "new content").unwrap();
    assert_eq!(
        missing_root
            .answer("capability.fs.read", &json!({"path":absent}))
            .unwrap(),
        json!({"missing":true})
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn listing_enforces_issued_root_scope_regular_files_and_limit() {
    let home = std::env::temp_dir().join(format!("pacer-list-{}", uuid::Uuid::new_v4()));
    let root = home.join("logs");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("rollout-a.jsonl"), "a").unwrap();
    fs::write(root.join("nested/rollout-b.jsonl"), "b").unwrap();
    fs::write(root.join("rollout-c.jsonl"), "c").unwrap();
    fs::write(root.join("private.jsonl"), "secret").unwrap();
    symlink(
        root.join("rollout-a.jsonl"),
        root.join("rollout-link.jsonl"),
    )
    .unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    let scopes = vec![
        "${HOME}/logs/**/rollout-*.jsonl".into(),
        "${HOME}/logs/rollout-*.jsonl".into(),
    ];
    let roots = ScopeRoots {
        home: Some(home.to_str().unwrap().into()),
        ..Default::default()
    };
    let listed = reader
        .list(
            &json!({"dir":root,"glob":"**/rollout-*.jsonl","limit":1}),
            &scopes,
            &roots,
            &authority,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(listed["files"].as_array().unwrap().len(), 1);
    assert_eq!(listed["complete"], false);
    let listed = reader
        .list(
            &json!({"dir":root,"glob":"**/rollout-*.jsonl"}),
            &scopes,
            &roots,
            &authority,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    let paths: Vec<_> = listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths.len(), 3);
    assert!(
        paths
            .iter()
            .all(|p| p.contains("rollout-") && !p.contains("link"))
    );
    assert_eq!(listed["complete"], true);
    assert!(matches!(
        reader.list(
            &json!({"dir":root,"glob":"*"}),
            &scopes,
            &roots,
            &authority,
            std::time::Instant::now()
        ),
        Err(BrokerError::Timeout)
    ));
    fs::rename(&root, home.join("old")).unwrap();
    fs::create_dir(&root).unwrap();
    assert!(
        reader
            .list(
                &json!({"dir":root,"glob":"*"}),
                &scopes,
                &roots,
                &authority,
                std::time::Instant::now() + std::time::Duration::from_secs(5)
            )
            .is_err()
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn listing_keeps_newest_after_more_than_one_thousand_matches() {
    let root = std::env::temp_dir().join(format!("pacer-list-many-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    for index in 0..1002 {
        fs::write(root.join(format!("rollout-{index}.jsonl")), "{}").unwrap();
    }
    std::thread::sleep(std::time::Duration::from_millis(20));
    let latest = root.join("rollout-zz-newest.jsonl");
    fs::write(&latest, "{}").unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    let scopes = vec![format!("{}/**", root.display())];
    let result = reader
        .list(
            &json!({"dir":root,"glob":"**/rollout-*.jsonl","limit":15}),
            &scopes,
            &ScopeRoots::default(),
            &authority,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(result["files"].as_array().unwrap().len(), 15);
    assert_eq!(result["files"][0]["path"], latest.to_str().unwrap());
    assert_eq!(result["complete"], false);
    fs::remove_dir_all(root).unwrap();
}
