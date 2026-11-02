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
        .update(ID, 1, 2.0, |t| t["state"] = json!("stopped"))
        .unwrap();
    assert!(std::fs::read_to_string(path).unwrap().contains("KEEP"));
}

#[test]
fn refuses_array_mutation_when_lossless_string_identity_is_ambiguous() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("tasks")).unwrap();
    let path = home.path().join("tasks").join(format!("{ID}.json"));
    let input = format!(
        r#"{{"id":"{ID}","rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{{"repo":"/fixture"}},"extra":["\ud800","\ud801"]}}"#
    );
    std::fs::write(&path, &input).unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    let result = store.update(ID, 1, 2.0, |task| {
        task["extra"].as_array_mut().unwrap().remove(0);
    });
    assert!(matches!(
        result,
        Err(pacer_store::StoreError::CompatibilityRequired)
    ));
    assert_eq!(std::fs::read_to_string(path).unwrap(), input);
    assert!(
        store
            .read_wire(ID)
            .unwrap()
            .unwrap()
            .to_json()
            .unwrap()
            .contains(r#"["\ud800","\ud801"]"#)
    );
}

#[test]
fn explicit_replacement_stores_literal_replacement_character_over_lone_surrogate() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("tasks")).unwrap();
    let path = home.path().join("tasks").join(format!("{ID}.json"));
    std::fs::write(&path, format!(r#"{{"id":"{ID}","rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{{"repo":"/fixture"}},"title":"\ud800","goal":"\ud801"}}"#)).unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    // The lossy preview of "\ud800" is U+FFFD, so a closure assignment of the
    // same text is indistinguishable from leaving the title untouched.
    store
        .update_with_strings(
            ID,
            1,
            2.0,
            |t| t["state"] = json!("stopped"),
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
