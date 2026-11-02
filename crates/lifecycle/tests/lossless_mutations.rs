#![allow(clippy::unwrap_used)]
use pacer_lifecycle::{AdmissionError, AdmissionState, MutationError, PreparedAdmission};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, path::Path};

const ID: &str = "t-20261102-000000-0001";
fn imported(queue: &str) -> (tempfile::TempDir, AdmissionState) {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("tasks")).unwrap();
    let record = format!(
        r#"{{"id":"{ID}","rev":1,"brief":{{"repo":"/repo","goal":"work"}},"state":"queued","createdAt":1,"attempts":[],"timeoutS":60,"items":["\ud800",{{"x":"\udfff"}}],"queue":{queue}}}"#
    );
    fs::write(dir.path().join(format!("tasks/{ID}.json")), record).unwrap();
    let state = AdmissionState::open(dir.path()).unwrap();
    (dir, state)
}
fn durable(home: &Path) -> (String, String) {
    let file = fs::read_to_string(home.join(format!("tasks/{ID}.json"))).unwrap();
    let record = Connection::open(home.join("state/tasks.db"))
        .unwrap()
        .query_row("SELECT record FROM tasks WHERE id=?", [ID], |r| r.get(0))
        .unwrap();
    (file, record)
}
fn exact_publication(home: &Path) {
    let (file, record) = durable(home);
    assert_eq!(file, record);
    assert!(
        file.contains(r#""items":["\ud800",{"x":"\udfff"}]"#),
        "{file}"
    );
}

#[test]
fn mutation_effect_and_conflict_results_retain_exact_text_and_rollback() {
    let (dir, mut state) = imported("null");
    state
        .tasks
        .connection()
        .unwrap()
        .execute_batch("CREATE TABLE effect_rows(value TEXT)")
        .unwrap();
    let before = durable(dir.path());
    let error = state
        .mutate(ID, 2.0, 2.0, |_, _| panic!("stale effect"))
        .unwrap_err();
    let MutationError::Conflict { task } = error else {
        panic!("expected conflict")
    };
    assert_eq!(
        task.subtree("/items").unwrap().to_json().unwrap(),
        r#"["\ud800",{"x":"\udfff"}]"#
    );
    let result = state.mutate(ID, 1.0, 2.0, |db, edit| {
        assert!(!db.is_autocommit());
        db.execute("INSERT INTO effect_rows VALUES('tentative')", [])?;
        edit.copy("/items", "/copy")?;
        Err(AdmissionError("rejected".into()))
    });
    assert!(result.is_err());
    assert_eq!(durable(dir.path()), before);
    let count: i64 = state
        .tasks
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM effect_rows", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    let reply = state
        .mutate(ID, 1.0, 3.0, |_, edit| Ok(edit.copy("/items", "/copy")?))
        .unwrap();
    assert_eq!(
        reply.subtree("/copy").unwrap().to_json().unwrap(),
        r#"["\ud800",{"x":"\udfff"}]"#
    );
    assert_eq!(reply.preview()["rev"], 2);
    exact_publication(dir.path());
}

#[test]
fn prepared_mutation_checks_cas_and_receipt_before_exact_effect() {
    let (dir, mut state) = imported("null");
    let before = durable(dir.path());
    for stale_revision in [true, false] {
        let mut receipt = PreparedAdmission::prepare(
            json!({}),
            &[],
            None,
            || Ok(json!({"rev":1})),
            |_| Ok(()),
            |input| Ok(input.clone()),
        )
        .unwrap();
        let result = state.mutate_prepared(
            &mut receipt,
            ID,
            if stale_revision { 2 } else { 1 },
            2.0,
            || Ok(json!({"rev":if stale_revision {1} else {2}})),
            |_, _| panic!("stale receipt effect"),
        );
        assert!(result.is_err());
        assert_eq!(durable(dir.path()), before);
    }
    let mut receipt = PreparedAdmission::prepare(
        json!({}),
        &[],
        None,
        || Ok(json!({})),
        |_| Ok(()),
        |input| Ok(input.clone()),
    )
    .unwrap();
    let reply = state
        .mutate_prepared(
            &mut receipt,
            ID,
            1,
            3.0,
            || Ok(json!({})),
            |_, edit| Ok(edit.copy("/items", "/copy")?),
        )
        .unwrap();
    assert_eq!(
        reply.subtree("/copy").unwrap().to_json().unwrap(),
        r#"["\ud800",{"x":"\udfff"}]"#
    );
    exact_publication(dir.path());
}

#[test]
fn final_prepared_guard_runs_inside_the_writer_transaction_and_consumes_receipt() {
    let (dir, mut state) = imported("null");
    let before = durable(dir.path());
    let mut receipt = PreparedAdmission::prepare(
        json!({}),
        &[],
        None,
        || Ok(json!({})),
        |_| Ok(()),
        |input| Ok(input.clone()),
    )
    .unwrap();
    let calls = std::cell::Cell::new(0);
    let result = state.mutate_prepared(
        &mut receipt,
        ID,
        1,
        2.0,
        || {
            let call = calls.get() + 1;
            calls.set(call);
            if call == 3 {
                let other = Connection::open(dir.path().join("state/tasks.db"))?;
                other.busy_timeout(std::time::Duration::ZERO)?;
                let error = other.execute_batch("BEGIN IMMEDIATE").unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                return Ok(json!({"changed":true}));
            }
            Ok(json!({}))
        },
        |_, _| panic!("expired final receipt effect"),
    );
    assert!(result.is_err());
    assert_eq!(calls.get(), 3);
    assert_eq!(durable(dir.path()), before);
    assert!(
        state
            .mutate_prepared(
                &mut receipt,
                ID,
                1,
                2.0,
                || panic!("consumed receipt context"),
                |_, _| panic!("consumed receipt effect")
            )
            .is_err()
    );
}

#[test]
fn conflict_payload_defaults_missing_and_null_revision_without_losing_text() {
    for revision in [None, Some(serde_json::Value::Null)] {
        let (dir, mut state) = imported("null");
        let mut raw = state.tasks.read_wire(ID).unwrap().unwrap();
        if let Some(value) = revision {
            raw.put("/rev", pacer_js_json::WireReply::new(value))
                .unwrap();
        } else {
            raw.remove("/rev").unwrap();
        }
        state
            .tasks
            .connection()
            .unwrap()
            .execute(
                "UPDATE tasks SET record=? WHERE id=?",
                rusqlite::params![raw.to_json().unwrap(), ID],
            )
            .unwrap();
        let before = durable(dir.path());
        let error = state
            .mutate(ID, 2.0, 2.0, |_, _| panic!("stale effect"))
            .unwrap_err();
        let MutationError::Conflict { task } = error else {
            panic!("expected conflict")
        };
        assert_eq!(task.preview()["rev"], 1);
        assert_eq!(
            task.subtree("/items").unwrap().to_json().unwrap(),
            r#"["\ud800",{"x":"\udfff"}]"#
        );
        assert_eq!(durable(dir.path()), before);
    }
}

#[test]
fn review_probe_copies_exact_kind_but_keeps_label_effect_order_and_revision_guard() {
    for kind in [None, Some("null"), Some(r#"["\ud801",{"x":"\udfff"}]"#)] {
        let (dir, mut state) = imported("null");
        if let Some(kind) = kind {
            let source = pacer_js_json::WireReply::parse(kind).unwrap();
            state
                .tasks
                .edit(ID, 1, 1.0, |edit| edit.put("/kind", source))
                .unwrap();
        }
        let rev = if kind.is_some() { 2 } else { 1 };
        let home = dir.path();
        fs::write(home.join(".sqlite-proof-home"), "fixture").unwrap();
        fs::write(home.join("release"), "release").unwrap();
        let invoke = |revision: i64| {
            let output = std::process::Command::new(env!("CARGO_BIN_EXE_task_admission_probe"))
                .arg("review")
                .arg(home)
                .arg(ID)
                .arg(revision.to_string())
                .arg("accept")
                .arg(home.join("ready"))
                .arg(home.join("release"))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        assert_eq!(invoke(rev + 1)["code"], "conflict");
        assert!(!home.join("labels.jsonl").exists());
        assert_eq!(invoke(rev)["ok"], true);
        assert_eq!(
            fs::read_to_string(home.join("labels.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        let record = state.tasks.read_wire(ID).unwrap().unwrap();
        assert_eq!(record.preview()["rev"], rev + 1);
        assert_eq!(record.preview()["resolved"], "reviewed");
        assert_eq!(
            record.subtree("/review/kind").unwrap().to_json().unwrap(),
            kind.unwrap_or("null")
        );
        assert_eq!(
            record.subtree("/review").unwrap().to_json().unwrap(),
            format!(
                r#"{{"accepted":true,"kind":{},"note":null,"at":1}}"#,
                kind.unwrap_or("null")
            )
        );
        exact_publication(home);
    }
}
