#![allow(clippy::unwrap_used)]
use pacer_foundation::Ctx;
use pacer_read_model::{events::*, js::*};
use pacer_store::{TaskStore, append_outbox};
use serde_json::{Value, json};
use std::collections::HashMap;
fn ctx() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().join(".pacer"),
        HashMap::new(),
        1791633600.0,
    );
    (dir, ctx)
}
#[test]
fn standalone_v2_conversion_matches_all_golden_exclusions() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/read-model/ts-golden.json"
    ))
    .unwrap();
    for case in array(&golden["v2Exclusions"]) {
        let event = json!({"seq":number(V3_CURSOR_BASE+1.0),"at":1791633600,"type":case["type"],"data":{"area":case["area"],"id":case["id"],"key":case["id"]}});
        assert_eq!(v3_only(&event), case["discovery"].as_bool().unwrap());
        assert_eq!(to_v2_event(&event).unwrap_or(Value::Null), case["v2"]);
    }
}
#[test]
fn sse_replays_external_writer_retention_heartbeat_and_cancel() {
    let (_dir, ctx) = ctx();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let mut stream = SseCursor::new(None, Some("0"), 3, 0.0).unwrap();
    assert_eq!(CONNECTED, ": connected\n\n");
    assert_eq!(
        stream
            .poll(&ctx, &mut store, chrono_tz::UTC, &|_| false)
            .unwrap(),
        ""
    );
    // This write bypasses the ReadModel and its caches, as an external TS publisher does.
    append_outbox(&ctx,&[json!({"seq":1,"at":ctx.now,"envelope":{"type":"config","data":{"area":"config","at":ctx.now}}})]).unwrap();
    assert_eq!(
        stream
            .poll(&ctx, &mut store, chrono_tz::UTC, &|_| false)
            .unwrap(),
        "id: 3000000000001\nevent: config\ndata: {\"area\":\"config\",\"at\":1791633600}\n\n"
            .to_string()
    );
    assert_eq!(stream.last(), V3_CURSOR_BASE + 1.0);
    assert_eq!(stream.heartbeat(14999.0), None);
    assert_eq!(stream.heartbeat(15000.0), Some(KEEPALIVE));
    assert_eq!(stream.heartbeat(15001.0), None);
    stream.cancel();
    append_outbox(
        &ctx,
        &[json!({"seq":2,"envelope":{"type":"config","data":{"area":"strategy","at":ctx.now}}})],
    )
    .unwrap();
    assert_eq!(
        stream
            .poll(&ctx, &mut store, chrono_tz::UTC, &|_| false)
            .unwrap(),
        ""
    );
    assert_eq!(stream.heartbeat(30000.0), None);
    assert!(stream.is_closed());
    assert_eq!(stream.last(), V3_CURSOR_BASE + 1.0);
}
#[test]
fn retention_gaps_filtered_events_and_last_cursor_keep_replay_semantics() {
    let (_dir, ctx) = ctx();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let entries:Vec<_>=(1..=1251).map(|seq|json!({"seq":seq,"at":ctx.now,"envelope":{"type":"config","data":{"area":"config","at":ctx.now}}})).collect();
    append_outbox(&ctx, &entries).unwrap();
    let batch = events_since(&ctx, 1.0, 3, &mut store, chrono_tz::UTC, &|_| false).unwrap();
    assert_eq!(array(&batch["events"]).len(), 1001);
    assert_eq!(batch["reset"], true);
    assert_eq!(batch["events"][0]["seq"], number(V3_CURSOR_BASE));
    assert_eq!(batch["events"][1]["seq"], number(V3_CURSOR_BASE + 252.0));
    let empty = events_since(
        &ctx,
        9007199254740992.0,
        3,
        &mut store,
        chrono_tz::UTC,
        &|_| false,
    )
    .unwrap();
    assert_eq!(
        empty,
        json!({"events":[],"last":9007199254740992u64,"reset":false})
    );
    let file = ctx.pacer_home.join("link/outbox.jsonl");
    std::fs::write(file,"{\"seq\":50,\"envelope\":{\"type\":\"config\",\"data\":{\"area\":\"discovery\",\"at\":1791633600}}}\n{torn").unwrap();
    let b = events_since(&ctx, 0.0, 2, &mut store, chrono_tz::UTC, &|_| false).unwrap();
    assert!(array(&b["events"]).is_empty());
    assert_eq!(b["last"], 50);
}
#[test]
fn oversized_entries_keep_the_ts_writer_retention_quirk() {
    let (_dir, ctx) = ctx();
    let padding = "x".repeat(pacer_store::outbox::OUTBOX_MAX_BYTES as usize);
    append_outbox(&ctx,&[json!({"seq":1,"at":ctx.now,"envelope":{"type":"alert","data":{"key":"large","level":"info","title":padding,"body":"","at":ctx.now}}})]).unwrap();
    let path = ctx.pacer_home.join("link/outbox.jsonl");
    assert!(std::fs::metadata(&path).unwrap().len() > pacer_store::outbox::OUTBOX_MAX_BYTES);
    assert_eq!(std::fs::read_to_string(path).unwrap().lines().count(), 1);
}

#[test]
fn idle_and_non_task_replay_do_not_decode_retained_question_bodies() {
    let (_dir, ctx) = ctx();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    // A legacy retained body that cannot decode as text is a read tripwire.
    // Idle replay must not select it, even with human questions retained.
    store
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TABLE messages(id TEXT, recipient TEXT, kind TEXT, body BLOB);
         INSERT INTO messages VALUES('retained', 'human', 'question', x'80ff');",
        )
        .unwrap();
    for protocol in [2, 3] {
        let empty =
            events_document(&ctx, 0.0, protocol, &mut store, chrono_tz::UTC, &|_| false).unwrap();
        assert_eq!(empty.value["events"], json!([]));
    }
    append_outbox(
        &ctx,
        &[
            json!({"seq":1,"envelope":{"type":"config","data":{"area":"config","at":ctx.now}}}),
            json!({"seq":2,"envelope":{"type":"config","data":{"area":"discovery","at":ctx.now}}}),
        ],
    )
    .unwrap();
    let v2 = events_document(&ctx, 0.0, 2, &mut store, chrono_tz::UTC, &|_| false).unwrap();
    assert_eq!(v2.value["events"].as_array().unwrap().len(), 1);
    assert_eq!(v2.value["last"], 2);
    let filtered = events_document(&ctx, 1.0, 2, &mut store, chrono_tz::UTC, &|_| false).unwrap();
    assert_eq!(filtered.value["events"], json!([]));
    assert_eq!(filtered.value["last"], 2);
    let v3 = events_document(&ctx, 0.0, 3, &mut store, chrono_tz::UTC, &|_| false).unwrap();
    assert_eq!(v3.value["events"].as_array().unwrap().len(), 2);
    assert_eq!(v3.value["last"], number(V3_CURSOR_BASE + 2.0));
}

#[test]
fn task_question_after_idle_keeps_latest_id_full_title_and_utf16_clipping() {
    let (_dir, ctx) = ctx();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let task = json!({"id":"t-20261110-120000-abcd","rev":1,"createdAt":ctx.now,"state":"running","brief":{"goal":"Full task title","repo":ctx.home},"attempts":[],"kind":null});
    pacer_foundation::fsutil::write_json_atomic(
        &ctx.pacer_home.join("tasks/t-20261110-120000-abcd.json"),
        &task,
    )
    .unwrap();
    store.reconcile_json().unwrap();
    assert!(store.read("t-20261110-120000-abcd").unwrap().is_some());
    store.connection().unwrap().execute_batch(
        "CREATE TABLE messages(id TEXT,task_id TEXT,recipient TEXT,kind TEXT,body TEXT,status TEXT,created_at REAL);
         INSERT INTO messages VALUES('a','t-20261110-120000-abcd','human','question','older','pending',1);"
    ).unwrap();
    let body = format!("{}😀suffix", "x".repeat(999));
    store
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO messages VALUES('b','t-20261110-120000-abcd','human','question',?,'pending',2)",
            [&body],
        )
        .unwrap();
    assert_eq!(
        events_document(&ctx, 0.0, 3, &mut store, chrono_tz::UTC, &|_| false)
            .unwrap()
            .value["events"],
        json!([])
    );
    append_outbox(&ctx, &[json!({"seq":1,"envelope":{"type":"task","data":{"id":"t-20261110-120000-abcd","state":"running","goal":"Full task title","title":"Full task title","executor":null,"updatedAt":ctx.now}}})]).unwrap();
    for protocol in [2, 3] {
        let doc =
            events_document(&ctx, 0.0, protocol, &mut store, chrono_tz::UTC, &|_| false).unwrap();
        assert_eq!(
            doc.value["events"][0]["data"]["fullTitle"],
            "Full task title"
        );
        assert_eq!(
            doc.value["events"][0]["data"]["messages"]["question"]["id"],
            "b"
        );
        assert!(doc.json().contains(&format!("{}\\ud83d", "x".repeat(999))));
    }
}
