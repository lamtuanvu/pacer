#![allow(clippy::unwrap_used)]
use pacer_js_json::{Utf16String, WireReply};
use pacer_store::TaskStore;
use serde_json::json;
const ID: &str = "t-20261102-192418-ec6c";
#[test]
fn task_question_keeps_the_exact_js_slice_in_db_json_and_later_updates() {
    let home = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{"repo":"/fixture"}}),1.0).unwrap();
    store
        .edit_with_strings(
            ID,
            1,
            2.0,
            |t| t.put("/question", WireReply::new(json!({"text":"","at":2}))),
            &[("/question/text".into(), Utf16String::slice("a😀", 0, 2))],
        )
        .unwrap();
    let raw =
        std::fs::read_to_string(home.path().join("tasks").join(format!("{ID}.json"))).unwrap();
    assert!(raw.contains(r#""text":"a\ud83d""#));
    let current = store.read(ID).unwrap().unwrap();
    assert_eq!(current["rev"], 2);
    store
        .edit(ID, 2, 3.0, |t| {
            t.put("/state", WireReply::new(json!("needs_input")))
        })
        .unwrap();
    drop(store);
    let mut reopened = TaskStore::open(home.path()).unwrap();
    let raw = reopened.read_wire(ID).unwrap().unwrap().to_json().unwrap();
    assert!(raw.contains(r#""text":"a\ud83d""#));
    assert!(
        reopened
            .edit_with_strings(ID, 1, 4.0, |_| Ok(()), &[])
            .is_err()
    );
    assert_eq!(
        reopened.read_wire(ID).unwrap().unwrap().to_json().unwrap(),
        raw
    );
}
#[test]
fn imports_ts_json_with_surrogates_without_discarding_the_record() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("tasks")).unwrap();
    let text = format!(
        r#"{{"id":"{ID}","rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{{"repo":"/fixture"}},"question":{{"text":"\ud83d"}}}}"#
    );
    std::fs::write(home.path().join("tasks").join(format!("{ID}.json")), text).unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    assert!(
        store
            .read_wire(ID)
            .unwrap()
            .unwrap()
            .to_json()
            .unwrap()
            .contains(r#""text":"\ud83d""#)
    );
    store
        .edit(ID, 1, 2.0, |t| {
            t.put("/state", WireReply::new(json!("stopped")))
        })
        .unwrap();
    assert!(
        store
            .read_wire(ID)
            .unwrap()
            .unwrap()
            .to_json()
            .unwrap()
            .contains(r#""text":"\ud83d""#)
    );
}
#[test]
fn text_override_cannot_change_task_identity_state_or_revision() {
    let home = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{"repo":"/fixture"}}),1.0).unwrap();
    for path in ["/id", "/state", "/rev", "/brief/repo"] {
        assert!(
            store
                .edit_with_strings(
                    ID,
                    1,
                    2.0,
                    |_| Ok(()),
                    &[(path.into(), Utf16String::slice("stopped", 0, 7))]
                )
                .is_err()
        );
    }
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 1);
}

#[test]
fn duplicate_title_winner_survives_import_and_unrelated_update() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("tasks")).unwrap();
    let path = home.path().join("tasks").join(format!("{ID}.json"));
    std::fs::write(&path, format!(r#"{{"id":"{ID}","rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{{"repo":"/fixture"}},"title":"\ud800","title":"KEEP"}}"#)).unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    assert!(
        store
            .read_wire(ID)
            .unwrap()
            .unwrap()
            .to_json()
            .unwrap()
            .contains("KEEP")
    );
    store
        .edit(ID, 1, 2.0, |t| {
            t.put("/state", WireReply::new(json!("stopped")))
        })
        .unwrap();
    assert!(std::fs::read_to_string(path).unwrap().contains("KEEP"));
}

#[test]
fn array_removal_preserves_exact_survivor_in_json_sqlite_and_reopen() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("tasks")).unwrap();
    let path = home.path().join("tasks").join(format!("{ID}.json"));
    let input = format!(
        r#"{{"id":"{ID}","rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{{"repo":"/fixture"}},"extra":["\ud800","\ud801"]}}"#
    );
    std::fs::write(&path, &input).unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    let reply = store
        .edit(ID, 1, 2.0, |task| task.remove("/extra/0"))
        .unwrap();
    let expected = reply.to_json().unwrap();
    // Execute the same array removal in JavaScript to check UTF-16 identity,
    // independently of the Rust edit and serializer implementations.
    let oracle = std::process::Command::new("bun")
        .arg("-e")
        .arg("const task = JSON.parse(process.env.TEST_TASK); task.extra.splice(0, 1); process.stdout.write(JSON.stringify(task.extra));")
        .env("TEST_TASK", &input)
        .env("HOME", home.path())
        .env("PACER_HOME", home.path())
        .current_dir(home.path())
        .output()
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    assert_eq!(
        reply
            .subtree("/extra")
            .unwrap()
            .to_json()
            .unwrap()
            .as_bytes(),
        oracle.stdout
    );
    assert_eq!(reply.preview()["rev"], 2);
    assert_eq!(
        reply.subtree("/extra").unwrap().to_json().unwrap(),
        r#"["\ud801"]"#
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
    let record: String = store
        .connection()
        .unwrap()
        .query_row("SELECT record FROM tasks WHERE id=?", [ID], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(record, expected);
    drop(store);
    let mut reopened = TaskStore::open(home.path()).unwrap();
    assert_eq!(
        reopened.read_wire(ID).unwrap().unwrap().to_json().unwrap(),
        expected
    );
}

#[test]
fn explicit_replacement_stores_literal_replacement_character_over_lone_surrogate() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("tasks")).unwrap();
    let path = home.path().join("tasks").join(format!("{ID}.json"));
    std::fs::write(&path, format!(r#"{{"id":"{ID}","rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{{"repo":"/fixture"}},"title":"\ud800","goal":"\ud801"}}"#)).unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    // Explicit overrides replace exact text even when the read-only preview
    // already contains the same U+FFFD character.
    store
        .edit_with_strings(
            ID,
            1,
            2.0,
            |t| t.put("/state", WireReply::new(json!("stopped"))),
            &[("/title".into(), Utf16String::slice("\u{FFFD}", 0, 1))],
        )
        .unwrap();
    for raw in [
        std::fs::read_to_string(&path).unwrap(),
        store.read_wire(ID).unwrap().unwrap().to_json().unwrap(),
    ] {
        assert!(raw.contains("\"title\":\"\u{FFFD}\""), "{raw}");
        assert!(!raw.contains(r"\ud800"), "{raw}");
        assert!(raw.contains(r#""goal":"\ud801""#), "{raw}");
        assert!(raw.contains(r#""state":"stopped""#), "{raw}");
    }
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 2);
}
