#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    fs::write(
        dir.path().join("strategy.yaml"),
        "planner: claude-code\naccounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\n",
    )
    .unwrap();
    Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    )
}

fn store(dir: &tempfile::TempDir) -> String {
    fs::read_to_string(dir.path().join("state/attention.json")).unwrap()
}

#[test]
fn params_match_zod_issue_text() {
    let error = |params: Value, snooze: bool| parse(&params, snooze).unwrap_err().message;
    assert_eq!(
        error(json!({}), false),
        "id: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        error(json!({"id": ""}), false),
        "id: Too small: expected string to have >=1 characters"
    );
    assert_eq!(
        error(json!({"id": "x".repeat(257)}), false),
        "id: Too big: expected string to have <=256 characters"
    );
    assert_eq!(
        error(json!({"id": "a", "for": "2h"}), true),
        r#"for: Invalid option: expected one of "1h"|"4h"|"1d""#
    );
    assert_eq!(
        error(json!([]), true),
        "params: Invalid input: expected object, received array"
    );
    assert_eq!(
        parse(&json!({"id": "a", "for": "4h", "x": 1}), true).unwrap(),
        ("a".into(), "4h")
    );
}

#[test]
fn forwards_items_and_stores_typescript_owns() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let forwarded = |op: &str, id: &str| attention_stays_forwarded(&c, op, &json!({"id": id}));
    assert!(!forwarded("attention.dismiss", "setup:usage"));
    assert!(!forwarded("attention.snooze", "failed:t-1"));
    assert!(forwarded("attention.dismiss", "failed:t-1"));
    assert!(forwarded("attention.snooze", "discovery-network:abc"));
    assert!(!forwarded("task.get", "failed:t-1"));
    fs::create_dir_all(dir.path().join("state")).unwrap();
    fs::write(
        dir.path().join("state/attention.json"),
        r#"{"setup:usage":5}"#,
    )
    .unwrap();
    assert!(forwarded("attention.dismiss", "setup:usage"));
    assert!(!forwarded("attention.dismiss", "setup:other"));
    fs::write(dir.path().join("state/attention.json"), "[]").unwrap();
    assert!(forwarded("attention.dismiss", "setup:other"));
    fs::write(dir.path().join("state/attention.json"), "not json").unwrap();
    assert!(!forwarded("attention.dismiss", "setup:other"));
    fs::write(dir.path().join("strategy.yaml"), "planner: [").unwrap();
    assert!(forwarded("attention.dismiss", "setup:other"));
}

#[test]
fn transactions_follow_the_typescript_store() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir);
    let items = vec![json!({"id": "setup:usage"})];
    let unknown = transaction(&c, "setup:x", &items, true, |_| {}).unwrap_err();
    assert_eq!(
        (unknown.code, unknown.message.as_str()),
        (Code::UnknownTask, "unknown attention item \"setup:x\"")
    );
    transaction(&c, "setup:usage", &items, true, |e| {
        let since = e["since"].clone();
        e.insert("dismissedSince".into(), since);
    })
    .unwrap();
    assert_eq!(
        store(&dir),
        r#"{"setup:usage":{"since":1700000000,"dismissedSince":1700000000}}"#
    );
    transaction(&c, "setup:usage", &[], true, |_| {}).unwrap();
    assert!(transaction(&c, "setup:usage", &[], false, |_| {}).is_err());
    fs::write(
        dir.path().join("state/attention.json"),
        r#"{"a":{"since":1.0,"dismissedSince":1},"b":{"since":{},"dismissedSince":{}},"c":{}}"#,
    )
    .unwrap();
    transaction(&c, "a", &[], true, |_| {}).unwrap();
    assert!(transaction(&c, "b", &[], true, |_| {}).is_err());
    transaction(&c, "c", &[], true, |e| {
        e.insert("snoozedUntil".into(), js::number(1_700_003_600.0));
    })
    .unwrap();
    assert_eq!(
        store(&dir),
        r#"{"a":{"since":1,"dismissedSince":1},"b":{"since":{},"dismissedSince":{}},"c":{"snoozedUntil":1700003600}}"#
    );
}
