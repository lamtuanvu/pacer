#![allow(clippy::unwrap_used)]
use pacer_js_json::Utf16String;
use pacer_store::TaskStore;
use serde_json::json;
const ID: &str = "t-20261102-192418-ec6c";
#[test]
fn task_question_keeps_the_exact_js_slice_in_db_json_and_later_updates() {
    let home = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{"repo":"/fixture"}}),1.0).unwrap();
    store
        .update_with_strings(
            ID,
            1,
            2.0,
            |t| {
                t["question"] = json!({"text":"","at":2});
            },
            &[("/question/text".into(), Utf16String::slice("a😀", 0, 2))],
        )
        .unwrap();
    let raw =
        std::fs::read_to_string(home.path().join("tasks").join(format!("{ID}.json"))).unwrap();
    assert!(raw.contains(r#""text":"a\ud83d""#));
    let current = store.read(ID).unwrap().unwrap();
    assert_eq!(current["rev"], 2);
    store
        .update(ID, 2, 3.0, |t| t["state"] = json!("needs_input"))
        .unwrap();
    drop(store);
    let mut reopened = TaskStore::open(home.path()).unwrap();
    let raw = reopened.read_wire(ID).unwrap().unwrap().to_json().unwrap();
    assert!(raw.contains(r#""text":"a\ud83d""#));
    assert!(
        reopened
            .update_with_strings(ID, 1, 4.0, |_| {}, &[])
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
        .update(ID, 1, 2.0, |t| t["state"] = json!("stopped"))
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
                .update_with_strings(
                    ID,
                    1,
                    2.0,
                    |_| {},
                    &[(path.into(), Utf16String::slice("stopped", 0, 7))]
                )
                .is_err()
        );
    }
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 1);
}
