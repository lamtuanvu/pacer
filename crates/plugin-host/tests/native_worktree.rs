#![allow(clippy::unwrap_used)]
#[path = "support/exact_task.rs"]
mod exact_task;
use pacer_plugin_host::NativeWorktree;
use pacer_store::TaskStore;
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    process::Command,
    time::{Duration, Instant},
};

#[tokio::test]
async fn creates_journaled_task_owned_worktree_and_refuses_owner_races() {
    let root = std::env::temp_dir().join(format!("pacer-worktree-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let repo = root.join("repo");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir(&repo).unwrap();
    let env = HashMap::from([
        ("HOME".into(), home.to_str().unwrap().into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_CONFIG_SYSTEM".into(), "/dev/null".into()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ]);
    for args in [
        vec!["init", "-q"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            Command::new("/usr/bin/git")
                .args(args)
                .current_dir(&repo)
                .env_clear()
                .envs(&env)
                .status()
                .unwrap()
                .success()
        );
    }
    let id = "t-20261102-125719-c5fb";
    let mut store = TaskStore::open(&home).unwrap();
    store.insert(&json!({"id":id,"rev":1,"createdAt":1,"state":"running","executorProvider":"fx-executor","attempts":[],"brief":{"repo":repo}}),1.0).unwrap();
    exact_task::seed(&home, id);
    let mut native = NativeWorktree::issue(
        &home,
        id,
        "fx-executor",
        1,
        "HEAD",
        "/usr/bin/git",
        env.clone(),
    )
    .await
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let base = native
        .answer(
            "capability.worktree.resolveBase",
            &json!({"taskId":id,"attempt":1}),
            deadline,
        )
        .await
        .unwrap();
    let result = native
        .answer(
            "capability.worktree.createOrReuse",
            &json!({"taskId":id,"attempt":1,"baseSha":base["sha"]}),
            deadline,
        )
        .await
        .unwrap();
    assert_eq!(result["reused"], false);
    assert!(std::path::Path::new(result["path"].as_str().unwrap()).is_dir());
    assert!(
        store
            .read(id)
            .unwrap()
            .unwrap()
            .get("worktreeIntent")
            .is_some()
    );
    assert!(
        native
            .answer(
                "capability.worktree.createOrReuse",
                &json!({"taskId":id,"attempt":1,"baseSha":base["sha"]}),
                deadline
            )
            .await
            .is_err()
    );
    let mut native =
        NativeWorktree::issue(&home, id, "fx-executor", 1, "HEAD", "/usr/bin/git", env)
            .await
            .unwrap();
    let task = store.read(id).unwrap().unwrap();
    store
        .edit(id, task["rev"].as_i64().unwrap(), 2.0, |v| {
            v.put(
                "/stopPending",
                pacer_plugin_host::WireReply::new(json!(true)),
            )
        })
        .unwrap();
    assert!(
        native
            .answer(
                "capability.worktree.inspect",
                &json!({"taskId":id,"attempt":1}),
                deadline
            )
            .await
            .is_err()
    );
    exact_task::assert_preserved(&home, id);
    fs::remove_dir_all(root).unwrap();
}
