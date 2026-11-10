#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;

#[test]
fn merge_enrichment_overlays_git_and_tokens() {
    let mut detail = json!({"id": "t-1", "files": []})
        .as_object()
        .unwrap()
        .clone();
    merge_enrichment(
        &mut detail,
        &json!({
            "files": [{"path": "a.ts", "status": "modified"}],
            "tokens": {"total": 1},
            "omitResultAcceptance": true,
        }),
    );
    assert_eq!(detail["files"].as_array().unwrap().len(), 1);
    assert_eq!(detail["tokens"]["total"], 1);
}

#[tokio::test(flavor = "current_thread")]
async fn cold_task_get_does_not_block_runtime_timers() {
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
        Default::default(),
        100.,
    );
    let id = "t-20260101-000001-aaaa";
    let mut store = TaskStore::open(dir.path()).unwrap();
    store.insert(&json!({"id":id,"rev":1,"state":"done","createdAt":1,"brief":{"repo":"/repo"},"attempts":[{"startedAt":10,"endedAt":20,"usageAtStart":{}}]}),1.).unwrap();
    let (send, receive) = mpsc::channel();
    // The blocking cost bootstrap must wait for this external writer. A Tokio
    // current-thread timer must still run while that task.get is pending.
    let holder = thread::spawn(move || {
        store
            .connection()
            .unwrap()
            .execute_batch("BEGIN IMMEDIATE")
            .unwrap();
        send.send(()).unwrap();
        thread::sleep(Duration::from_millis(250));
        store.connection().unwrap().execute_batch("COMMIT").unwrap();
    });
    receive.recv().unwrap();
    let request = tokio::spawn(async move {
        task_get_with_probe(
            &ctx,
            id,
            SessionProbeParts {
                active: Default::default(),
                alive_pids: Default::default(),
            },
            Value::Null,
            false,
        )
        .await
    });
    let start = Instant::now();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let elapsed = start.elapsed();
    request.await.unwrap().unwrap();
    holder.join().unwrap();
    assert!(
        elapsed < Duration::from_millis(150),
        "runtime timer stalled for {elapsed:?}"
    );
}
