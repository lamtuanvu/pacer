use super::*;
use pacer_plugin_host::WireReply;

fn put(root: &std::path::Path, id: &str, fields: &[(&str, &str)]) {
    let mut store = pacer_store::TaskStore::open(root).unwrap();
    let rev = store.read(id).unwrap().unwrap()["rev"].as_i64().unwrap();
    store
        .edit(id, rev, 2.0, |edit| {
            for (path, raw) in fields {
                edit.put(path, WireReply::parse(raw).unwrap())?;
            }
            Ok(())
        })
        .unwrap();
}
fn exact(root: &std::path::Path, id: &str, path: &str, expected: &str) {
    let mut store = pacer_store::TaskStore::open(root).unwrap();
    let task = store.read_wire(id).unwrap().unwrap();
    assert_eq!(
        task.subtree(path).unwrap().to_json().unwrap(),
        WireReply::parse(expected).unwrap().to_json().unwrap()
    );
    let disk = WireReply::parse(
        &fs::read_to_string(root.join("tasks").join(format!("{id}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(
        disk.subtree(path).unwrap().to_json().unwrap(),
        task.subtree(path).unwrap().to_json().unwrap()
    );
}
#[tokio::test]
async fn metadata_and_question_keep_unknown_array_text() {
    let (root, mut a) = fixture("question-utf16");
    put(
        &root,
        ID,
        &[
            ("/extra", r#"["\ud800",{"x":"\udc01","literal":"�"}]"#),
            ("/interactionMode", r#""conversation""#),
        ],
    );
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    assert_eq!(
        a.invoke("wait", json!({})).await.unwrap()["state"],
        "needs_input"
    );
    a.invoke(
        "finish",
        json!({"code":1,"timedOut":false,"settled":false,"keepAlive":false}),
    )
    .await
    .unwrap();
    exact(
        &root,
        ID,
        "/extra",
        r#"["\ud800",{"x":"\udc01","literal":"�"}]"#,
    );
    exact(
        &root,
        ID,
        "/question/text",
        &format!("\"{}\\ud83d\"", "x".repeat(999)),
    );
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    assert!(store.read(ID).unwrap().unwrap().get("live").is_none());
    let calls = fs::read_to_string(root.join("calls.jsonl")).unwrap();
    assert!(calls.contains("Your question has been recorded"));
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn reattachment_copies_exact_snapshot_before_old_live_removal() {
    const OLD: &str = "t-20261102-175253-93d9";
    let (root, mut a) = fixture("reattach-exact");
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    let mut old = store.read(ID).unwrap().unwrap();
    old["id"] = json!(OLD);
    store.insert(&old, 1.0).unwrap();
    drop(store);
    let live = r#"{"backend":"orca","worker":"dispatch-owned","terminal":"agent-terminal","executor":"codex","agent":"codex","incarnation":"first","extra":["\ud800","�"]}"#;
    put(
        &root,
        OLD,
        &[
            ("/live", live),
            ("/interactionMode", r#""conversation""#),
            ("/question", r#"{"answer":"yes"}"#),
            (
                "/placement",
                r#"{"requested":"current","extra":["\udc01"]}"#,
            ),
            ("/baseBranch", r#""base\ud802""#),
            ("/group", r#""group\ud803""#),
        ],
    );
    put(
        &root,
        ID,
        &[
            ("/retryOf", &serde_json::to_string(OLD).unwrap()),
            ("/extra", r#"["\ud804"]"#),
        ],
    );
    assert_eq!(
        a.invoke("liveAnswer", json!({})).await.unwrap()["kind"],
        "attached"
    );
    exact(&root, ID, "/live", live);
    exact(
        &root,
        ID,
        "/placement",
        r#"{"requested":"current","extra":["\udc01"]}"#,
    );
    exact(&root, ID, "/baseBranch", r#""base\ud802""#);
    exact(&root, ID, "/group", r#""group\ud803""#);
    exact(&root, ID, "/extra", r#"["\ud804"]"#);
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    let old = store.read(OLD).unwrap().unwrap();
    assert!(old.get("live").is_none());
    assert_eq!(old["state"], "partial");
    assert_eq!(old["dismissed"], true);
    assert_eq!(a.invoke("wait", json!({})).await.unwrap()["kind"], "done");
    a.invoke(
        "finish",
        json!({"code":0,"timedOut":false,"settled":true,"keepAlive":false}),
    )
    .await
    .unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn placement_merge_keeps_unknown_nested_text() {
    let (root, old) = fixture("policy");
    drop(old);
    let mut a = policy_fixture(&root, false);
    put(
        &root,
        ID,
        &[("/placement/extra", r#"{"a/b~":["\ud800","�"]}"#)],
    );
    a.invoke("liveAnswer", json!({})).await.unwrap();
    assert_eq!(a.invoke("prepare", json!({})).await.unwrap()["ok"], true);
    exact(&root, ID, "/placement/extra", r#"{"a/b~":["\ud800","�"]}"#);
    exact(&root, ID, "/placement/requested", r#""current""#);
    a.invoke("abandon", json!({"reason":"fixture complete"}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn placement_why_derives_from_exact_reason() {
    let (root, old) = fixture("policy");
    drop(old);
    let mut a = policy_fixture(&root, false);
    put(
        &root,
        ID,
        &[("/placement/reason", r#""\ufeff \ud800 �\u2029""#)],
    );
    a.invoke("liveAnswer", json!({})).await.unwrap();
    assert_eq!(a.invoke("prepare", json!({})).await.unwrap()["ok"], true);
    exact(&root, ID, "/placement/why", r#""agent: \ud800 �""#);
    a.invoke("abandon", json!({"reason":"fixture complete"}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn kept_conversation_updates_since_without_replacing_live_descendants() {
    let (root, mut a) = fixture("question-utf16");
    put(&root, ID, &[("/interactionMode", r#""conversation""#)]);
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    put(
        &root,
        ID,
        &[
            ("/live/extra", r#"["\ud800",{"literal":"�"}]"#),
            ("/live/since", "0"),
        ],
    );
    assert_eq!(
        a.invoke("wait", json!({})).await.unwrap()["state"],
        "needs_input"
    );
    a.invoke(
        "finish",
        json!({"code":1,"timedOut":false,"settled":false,"keepAlive":true}),
    )
    .await
    .unwrap();
    exact(&root, ID, "/live/extra", r#"["\ud800",{"literal":"�"}]"#);
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    assert!(
        store.read(ID).unwrap().unwrap()["live"]["since"]
            .as_f64()
            .unwrap()
            > 0.0
    );
    let calls = fs::read_to_string(root.join("calls.jsonl")).unwrap();
    assert!(!calls.contains("worker-stop"));
    assert!(!calls.contains("terminal\", \"close"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn released_lane_removes_only_owned_paths_and_keeps_result_text() {
    let (root, old) = fixture("lane");
    drop(old);
    let mut a = policy_fixture(&root, true);
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    let lane = store.read(ID).unwrap().unwrap()["worktree"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = format!(
        r#"{{"worktree":{},"extra":["\ud800","�"]}}"#,
        serde_json::to_string(&lane).unwrap()
    );
    put(
        &root,
        ID,
        &[("/result", &result), ("/state", r#""stopped""#)],
    );
    assert_eq!(
        a.invoke("wait", json!({})).await.unwrap()["kind"],
        "stopped"
    );
    a.invoke(
        "finish",
        json!({"code":1,"timedOut":false,"settled":false,"keepAlive":false}),
    )
    .await
    .unwrap();
    assert!(!std::path::PathBuf::from(&lane).exists());
    let task = store.read(ID).unwrap().unwrap();
    assert!(task.get("worktree").is_none());
    assert!(task["result"].get("worktree").is_none());
    assert_eq!(task["worktreeReleased"]["path"], lane);
    exact(&root, ID, "/result/extra", r#"["\ud800","�"]"#);
    fs::remove_dir_all(root).unwrap();
}
