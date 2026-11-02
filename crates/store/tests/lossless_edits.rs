#![allow(clippy::unwrap_used)]
use pacer_js_json::{Utf16String, WireReply};
use pacer_store::{StoreError, TaskEdit, TaskStore};
use rusqlite::Connection;
use serde_json::json;
use std::{cell::Cell, fs, path::Path};

const ID: &str = "t-20261102-192418-ec6c";
fn wire(text: &str) -> WireReply {
    WireReply::parse(text).unwrap()
}
fn imported(extra: &str, repo: &str) -> (tempfile::TempDir, TaskStore) {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("tasks")).unwrap();
    fs::write(home.path().join(format!("tasks/{ID}.json")), format!(
        r#"{{"id":"{ID}","rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{{"repo":{repo}}},{extra}}}"#
    )).unwrap();
    let store = TaskStore::open(home.path()).unwrap();
    (home, store)
}
fn durable(home: &Path) -> (String, String) {
    let file = fs::read_to_string(home.join(format!("tasks/{ID}.json"))).unwrap();
    let db = Connection::open(home.join("state/tasks.db")).unwrap();
    let record = db
        .query_row("SELECT record FROM tasks WHERE id=?", [ID], |r| r.get(0))
        .unwrap();
    (file, record)
}
fn published(home: &Path, reply: &WireReply) {
    let (file, record) = durable(home);
    assert_eq!(file, record, "SQLite and JSON must publish identical bytes");
    assert_eq!(file, reply.to_json().unwrap());
}
fn exact(reply: &WireReply, pointer: &str, expected: &str) {
    assert_eq!(
        reply.subtree(pointer).unwrap().to_json().unwrap(),
        wire(expected).to_json().unwrap()
    );
}

#[test]
fn edits_preserve_exact_arrays_and_copies_through_publication_and_reopen() {
    let (home, mut store) = imported(
        r#""title":"\ud800","goal":"\udc01","items":["\ud801","\ud802"],"a/b~":{"x":["\ud803"]}"#,
        r#""/fixture""#,
    );
    let reply = store
        .edit(ID, 1, 2.0, |edit| {
            assert_eq!(edit.preview()["rev"], 1);
            edit.put("/metadata", WireReply::new(json!({"tick":2})))?;
            edit.copy("/title", "/copiedTitle")?;
            edit.put("/copiedTree", edit.subtree("/a~1b~0")?)?;
            edit.remove("/items/0")?;
            edit.splice("/items", 0, 0, vec![wire(r#"["\ud804"]"#)])?;
            Ok(())
        })
        .unwrap();
    exact(&reply, "/title", r#""\ud800""#);
    exact(&reply, "/goal", r#""\udc01""#);
    exact(&reply, "/copiedTitle", r#""\ud800""#);
    exact(&reply, "/copiedTree", r#"{"x":["\ud803"]}"#);
    exact(&reply, "/items", r#"[["\ud804"],"\ud802"]"#);
    assert_eq!(reply.preview()["rev"], 2);
    published(home.path(), &reply);
    assert_eq!(
        store.read_wire(ID).unwrap().unwrap().to_json().unwrap(),
        reply.to_json().unwrap()
    );
    drop(store);
    let mut reopened = TaskStore::open(home.path()).unwrap();
    let reply = reopened
        .edit(ID, 2, 3.0, |edit| {
            edit.set_string("/title", Utf16String::slice("�", 0, 1))?;
            edit.copy("/items", "/saved")?;
            edit.remove("/items/0")
        })
        .unwrap();
    exact(&reply, "/title", r#""�""#);
    exact(&reply, "/copiedTitle", r#""\ud800""#);
    exact(&reply, "/saved", r#"[["\ud804"],"\ud802"]"#);
    exact(&reply, "/items", r#"["\ud802"]"#);
    assert_eq!(reply.preview()["rev"], 3);
    published(home.path(), &reply);
}

#[test]
fn failed_edit_or_invalid_final_record_keeps_both_durable_representations_unchanged() {
    let (home, mut store) = imported(r#""items":["\ud800","\ud801"]"#, r#""/fixture""#);
    let before = durable(home.path());
    type RejectedEdit = fn(&mut TaskEdit) -> Result<(), StoreError>;
    let failures: [RejectedEdit; 5] = [
        |edit| {
            edit.remove("/items/0")?;
            edit.remove("/missing")
        },
        |edit| edit.put("/state", WireReply::new(json!("invalid"))),
        |edit| edit.remove("/createdAt"),
        |edit| edit.put("", WireReply::new(json!([]))),
        |edit| {
            edit.copy("/items", "/copy")?;
            Err(StoreError::Admission("rejected".into()))
        },
    ];
    for edit in failures {
        assert!(store.edit(ID, 1, 2.0, edit).is_err());
        assert_eq!(durable(home.path()), before);
    }
    let reply = store.edit(ID, 1, 3.0, |_| Ok(())).unwrap();
    assert_eq!(
        reply.preview()["rev"],
        2,
        "failed edits must not consume a revision"
    );
    published(home.path(), &reply);
}

#[test]
fn revision_conflict_does_not_run_the_editor_or_publish_either_copy() {
    let (home, mut first) = imported(r#""items":["\ud800"]"#, r#""/fixture""#);
    let mut second = TaskStore::open(home.path()).unwrap();
    first
        .edit(ID, 1, 2.0, |edit| edit.put("/title", wire(r#""winner""#)))
        .unwrap();
    let before = durable(home.path());
    let called = Cell::new(false);
    let result = second.edit(ID, 1, 3.0, |_| {
        called.set(true);
        Ok(())
    });
    assert!(matches!(result, Err(StoreError::Conflict)));
    assert!(!called.get());
    assert_eq!(durable(home.path()), before);
}

#[test]
fn exact_edits_keep_revision_settlement_and_indexed_metadata_rules() {
    let (home, mut store) = imported(r#""items":["\ud800"]"#, r#""/fixture""#);
    let reply = store
        .edit(ID, 1, 10.0, |edit| {
            edit.put("/id", wire(r#""ignored""#))?;
            edit.put("/rev", WireReply::new(json!(900)))?;
            edit.put("/state", wire(r#""done""#))?;
            edit.put("/brief/repo", wire(r#""/changed""#))?;
            edit.put("/review", WireReply::new(json!({"at":12})))
        })
        .unwrap();
    assert_eq!(reply.preview()["id"], ID);
    assert_eq!(reply.preview()["rev"], 2);
    assert_eq!(reply.preview()["settledAt"], 10.0);
    published(home.path(), &reply);
    let db = Connection::open(home.path().join("state/tasks.db")).unwrap();
    let indexed: (i64, String, f64, f64, f64, String) = db
        .query_row(
            "SELECT rev,state,created_at,updated_at,settled_at,repo FROM tasks WHERE id=?",
            [ID],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        indexed,
        (2, "done".into(), 1.0, 12.0, 12.0, "/changed".into())
    );
    let reply = store
        .edit(ID, 2, 13.0, |edit| edit.put("/state", wire(r#""running""#)))
        .unwrap();
    assert!(reply.preview().get("settledAt").is_none());
    published(home.path(), &reply);
    let reply = store
        .edit(ID, 3, 14.0, |edit| edit.put("/state", wire(r#""failed""#)))
        .unwrap();
    assert_eq!(reply.preview()["settledAt"], 14.0);
    let first: f64 = db
        .query_row(
            "SELECT at FROM task_first_settle WHERE task_id=?",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first, 10.0);
    published(home.path(), &reply);
}

#[test]
fn locked_task_uses_the_same_exact_write_route() {
    let (home, mut store) = imported(r#""title":"\ud800","items":["\ud801"]"#, r#""/fixture""#);
    let reply = store
        .with_task_lock(ID, |locked| {
            locked.edit(1, 2.0, |edit| {
                edit.copy("/items/0", "/title")?;
                edit.set_string("/items/0", Utf16String::slice("�", 0, 1))
            })
        })
        .unwrap();
    exact(&reply, "/title", r#""\ud801""#);
    exact(&reply, "/items", r#"["�"]"#);
    published(home.path(), &reply);
}

#[test]
fn accepted_non_scalar_repo_survives_an_unrelated_exact_edit() {
    let (home, mut store) = imported(r#""title":"\ud801""#, r#""\ud800""#);
    let db = Connection::open(home.path().join("state/tasks.db")).unwrap();
    let before: String = db
        .query_row("SELECT repo FROM tasks WHERE id=?", [ID], |r| r.get(0))
        .unwrap();
    let reply = store
        .edit(ID, 1, 2.0, |edit| {
            edit.put("/metadata", WireReply::new(json!(true)))
        })
        .unwrap();
    exact(&reply, "/brief/repo", r#""\ud800""#);
    let after: String = db
        .query_row("SELECT repo FROM tasks WHERE id=?", [ID], |r| r.get(0))
        .unwrap();
    assert_eq!(
        after, before,
        "existing indexed preview contract is retained"
    );
    published(home.path(), &reply);
}

#[test]
fn legacy_string_adapter_keeps_placeholder_restrictions_and_array_refusal() {
    let (home, mut store) = imported(r#""title":"\ud800","count":1"#, r#""/fixture""#);
    for path in ["/missing", "/count", "/id", "/state", "/rev", "/brief/repo"] {
        let before = durable(home.path());
        assert!(matches!(
            store.update_with_strings(
                ID,
                1,
                2.0,
                |_| {},
                &[(path.into(), Utf16String::slice("x", 0, 1))]
            ),
            Err(StoreError::InvalidRecord)
        ));
        assert_eq!(durable(home.path()), before);
    }
    store
        .update_with_strings(
            ID,
            1,
            2.0,
            |task| task["question"] = json!({"text":""}),
            &[("/question/text".into(), Utf16String::slice("😀", 0, 1))],
        )
        .unwrap();
    let reply = store.read_wire(ID).unwrap().unwrap();
    exact(&reply, "/question/text", r#""\ud83d""#);
    published(home.path(), &reply);
    store
        .edit(ID, 2, 3.0, |edit| edit.put("/items", wire(r#"["\ud801"]"#)))
        .unwrap();
    let before = durable(home.path());
    assert!(matches!(
        store.update_with_strings(ID, 3, 4.0, |_| {}, &[]),
        Err(StoreError::CompatibilityRequired)
    ));
    assert_eq!(durable(home.path()), before);
}

#[test]
fn admitted_edits_check_cas_before_effects_and_rollback_domain_rows() {
    let (home, mut store) = imported(r#""items":["\ud800"]"#, r#""/fixture""#);
    store
        .connection()
        .unwrap()
        .execute_batch("CREATE TABLE edit_effects(value TEXT)")
        .unwrap();
    let before = durable(home.path());
    let called = Cell::new(false);
    assert!(matches!(
        store.edit_admitted(ID, 2, 2.0, |_, _| {
            called.set(true);
            Ok(())
        }),
        Err(StoreError::Conflict)
    ));
    assert!(!called.get());
    for invalid_record in [false, true] {
        let result = store.edit_admitted(ID, 1, 2.0, |db, edit| {
            assert!(!db.is_autocommit());
            let other = Connection::open(home.path().join("state/tasks.db"))?;
            other.busy_timeout(std::time::Duration::ZERO)?;
            let busy = other.execute_batch("BEGIN IMMEDIATE").unwrap_err();
            assert_eq!(
                busy.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy)
            );
            db.execute("INSERT INTO edit_effects VALUES('tentative')", [])?;
            edit.copy("/items", "/copy")?;
            if invalid_record {
                edit.remove("/createdAt")
            } else {
                Err(StoreError::Admission("rejected".into()))
            }
        });
        assert!(result.is_err());
        assert_eq!(durable(home.path()), before);
        let count: i64 = store
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM edit_effects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    let reply = store
        .edit_admitted(ID, 1, 3.0, |db, edit| {
            db.execute("INSERT INTO edit_effects VALUES('accepted')", [])?;
            edit.copy("/items", "/copy")
        })
        .unwrap();
    exact(&reply, "/copy", r#"["\ud800"]"#);
    assert_eq!(reply.preview()["rev"], 2);
    published(home.path(), &reply);
    let count: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM edit_effects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn current_edits_use_latest_revision_and_unchanged_errors_publish_nothing() {
    let (home, mut first) = imported(
        r#""items":["\ud800"],"queue":{"position":1}"#,
        r#""/fixture""#,
    );
    let mut second = TaskStore::open(home.path()).unwrap();
    first
        .edit(ID, 1, 2.0, |edit| edit.remove("/queue"))
        .unwrap();
    let before = durable(home.path());
    let result = second.edit_current(ID, 3.0, |edit| {
        assert_eq!(edit.preview()["rev"], 2);
        if edit.preview().get("queue").is_none() {
            return Err(StoreError::Unchanged);
        }
        edit.put("/queue/position", WireReply::new(json!(4)))
    });
    assert!(matches!(result, Err(StoreError::Unchanged)));
    assert_eq!(durable(home.path()), before);
    let reply = second
        .edit_current(ID, 4.0, |edit| {
            edit.put("/dismissed", WireReply::new(json!(true)))
        })
        .unwrap();
    assert_eq!(reply.preview()["rev"], 3);
    exact(&reply, "/items", r#"["\ud800"]"#);
    published(home.path(), &reply);
    assert!(matches!(
        second.edit_current("bad-id", 5.0, |_| panic!("unknown task callback")),
        Err(StoreError::UnknownTask(_))
    ));
}

#[test]
fn exact_string_helper_validates_overrides_after_system_finalization() {
    let (home, mut store) = imported(r#""items":["\ud800"],"count":1"#, r#""/fixture""#);
    let reply = store
        .edit_with_strings(
            ID,
            1,
            2.0,
            |edit| edit.put("/question", WireReply::new(json!({"text":""}))),
            &[("/question/text".into(), Utf16String::slice("😀", 0, 1))],
        )
        .unwrap();
    exact(&reply, "/question/text", r#""\ud83d""#);
    exact(&reply, "/items", r#"["\ud800"]"#);
    published(home.path(), &reply);
    let before = durable(home.path());
    for path in ["/id", "/state", "/rev", "/brief/repo", "/missing", "/count"] {
        assert!(matches!(
            store.edit_with_strings(
                ID,
                2,
                3.0,
                |_| Ok(()),
                &[(path.into(), Utf16String::slice("x", 0, 1))]
            ),
            Err(StoreError::InvalidRecord)
        ));
        assert_eq!(durable(home.path()), before);
    }
    for state in ["running", "done"] {
        assert!(matches!(
            store.edit_with_strings(
                ID,
                2,
                3.0,
                |edit| {
                    edit.put("/state", WireReply::new(json!(state)))?;
                    edit.put("/settledAt", WireReply::new(json!("placeholder")))
                },
                &[("/settledAt".into(), Utf16String::slice("x", 0, 1))]
            ),
            Err(StoreError::InvalidRecord)
        ));
        assert_eq!(durable(home.path()), before);
    }
}

#[test]
fn locked_read_copies_exact_snapshot_without_a_mutable_preview() {
    let (home, mut store) = imported(r#""title":"\ud800","items":["\ud801"]"#, r#""/fixture""#);
    let reply = store
        .with_task_lock(ID, |locked| {
            let source = locked.read_wire()?;
            locked.edit(source.preview()["rev"].as_i64().unwrap(), 2.0, |edit| {
                edit.put("/saved", source.subtree("/items")?)
            })
        })
        .unwrap();
    exact(&reply, "/saved", r#"["\ud801"]"#);
    published(home.path(), &reply);
}

#[test]
fn retention_archive_and_restore_preserve_exact_record_and_return_wire() {
    let (home, mut store) = imported(
        r#""state":"done","settledAt":2,"dismissed":true,"items":["\ud800",{"x":"\ud801"}]"#,
        r#""/fixture""#,
    );
    let log = home.path().join(format!("tasks/{ID}.log"));
    fs::write(&log, b"log text\n").unwrap();
    let pruned = store.prune(1, false, 100000.0).unwrap();
    assert_eq!(pruned.tasks.len(), 1);
    let archived = store.read_wire(ID).unwrap().unwrap();
    exact(&archived, "/items", r#"["\ud800",{"x":"\ud801"}]"#);
    let archive_file = pruned.tasks[0].archive_path.join(format!("{ID}.json"));
    assert_eq!(
        fs::read_to_string(&archive_file).unwrap(),
        archived.to_json().unwrap()
    );
    assert!(!log.exists());
    drop(store);
    let mut store = TaskStore::open(home.path()).unwrap();
    let restored = store.restore(ID, 100001.0).unwrap();
    assert_eq!(restored.preview()["rev"], 3);
    assert!(restored.preview().get("archived").is_none());
    assert!(restored.preview().get("archivePath").is_none());
    exact(&restored, "/items", r#"["\ud800",{"x":"\ud801"}]"#);
    published(home.path(), &restored);
    assert_eq!(fs::read(&log).unwrap(), b"log text\n");
    assert!(!archive_file.exists());
    let again = store.restore(ID, 100002.0).unwrap();
    assert_eq!(again.to_json().unwrap(), restored.to_json().unwrap());
}

#[test]
fn proof_probe_single_record_output_preserves_exact_text() {
    let (home, mut store) = imported(r#""title":"9","items":["\ud800"]"#, r#""/fixture""#);
    fs::write(home.path().join(".sqlite-proof-home"), "fixture").unwrap();
    let invoke = |command: &str, extra: &[&str]| {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_task_store_probe"))
            .arg(command)
            .arg(home.path())
            .args(extra)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        wire(std::str::from_utf8(&output.stdout).unwrap().trim())
    };
    exact(&invoke("read", &[ID]), "/items", r#"["\ud800"]"#);
    let incremented = invoke("increment", &[ID]);
    exact(&incremented, "/items", r#"["\ud800"]"#);
    assert_eq!(incremented.preview()["title"], "10");
    assert_eq!(incremented.preview()["rev"], 2);
    published(home.path(), &incremented);
    store
        .edit(ID, 2, 3.0, |edit| {
            edit.put("/state", WireReply::new(json!("done")))?;
            edit.put("/dismissed", WireReply::new(json!(true)))
        })
        .unwrap();
    store.prune(1, false, 100000.0).unwrap();
    let restored = invoke("restore", &[ID, "100001"]);
    exact(&restored, "/items", r#"["\ud800"]"#);
    assert_eq!(restored.preview()["rev"], 5);
    published(home.path(), &restored);
}

#[test]
fn current_edits_and_restore_keep_read_default_for_absent_or_null_revision() {
    for revision in [None, Some(json!(null))] {
        let (home, mut store) = imported(
            r#""state":"done","settledAt":2,"dismissed":true,"items":["\ud800"]"#,
            r#""/fixture""#,
        );
        let mut raw = store.read_wire(ID).unwrap().unwrap();
        if let Some(value) = revision.clone() {
            raw.put("/rev", WireReply::new(value)).unwrap();
        } else {
            raw.remove("/rev").unwrap();
        }
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE tasks SET record=? WHERE id=?",
                rusqlite::params![raw.to_json().unwrap(), ID],
            )
            .unwrap();
        fs::write(home.path().join(".sqlite-proof-home"), "fixture").unwrap();
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_task_store_probe"))
            .arg("read")
            .arg(home.path())
            .arg(ID)
            .output()
            .unwrap();
        assert!(output.status.success());
        let read = wire(std::str::from_utf8(&output.stdout).unwrap());
        assert_eq!(read.preview()["rev"], 1);
        exact(&read, "/items", r#"["\ud800"]"#);
        let edited = store
            .edit_current(ID, 3.0, |edit| edit.put("/note", wire(r#""accepted""#)))
            .unwrap();
        assert_eq!(edited.preview()["rev"], 2);
        exact(&edited, "/items", r#"["\ud800"]"#);
        store.prune(1, false, 100000.0).unwrap();
        let mut raw = store.read_wire(ID).unwrap().unwrap();
        if let Some(value) = revision {
            raw.put("/rev", WireReply::new(value)).unwrap();
        } else {
            raw.remove("/rev").unwrap();
        }
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE tasks SET rev=1,record=? WHERE id=?",
                rusqlite::params![raw.to_json().unwrap(), ID],
            )
            .unwrap();
        let restored = store.restore(ID, 100001.0).unwrap();
        assert_eq!(restored.preview()["rev"], 2);
        exact(&restored, "/items", r#"["\ud800"]"#);
        published(home.path(), &restored);
    }
}
