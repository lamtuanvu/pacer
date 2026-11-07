#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn agent_follows_parse_runner_id() {
    assert_eq!(agent_of("codex#team"), "codex");
    assert_eq!(agent_of("claude-code#work@box"), "claude-code");
    assert_eq!(agent_of("cursor@local"), "cursor");
    assert_eq!(agent_of("codex#Team"), "codex#Team");
    assert_eq!(agent_of("other#a"), "other#a");
    assert_eq!(agent_of("codex#"), "codex#");
}

#[test]
fn object_keys_follow_javascript_property_order() {
    let out = js_object(vec![
        ("b".into(), json!(1)),
        ("10".into(), json!(2)),
        ("01".into(), json!(3)),
        ("2".into(), json!(4)),
    ]);
    assert_eq!(out.to_string(), r#"{"2":4,"10":2,"b":1,"01":3}"#);
}

#[test]
fn skipped_notes_stop_where_typescript_throws() {
    let note = |s: &str| skip_entries(&Sql::Text(s.into()));
    assert_eq!(
        note(r#"[{"executor":"codex#a","reason":"busy"},5,null,{"executor":"x"}]"#),
        [
            ("codex".to_owned(), "busy".to_owned()),
            ("undefined".to_owned(), "undefined".to_owned())
        ]
    );
    assert!(note("{}").is_empty());
    assert!(note("not json").is_empty());
    assert_eq!(
        note(r#"[{"executor":[1,null],"reason":2.5}]"#)[0],
        ("1,".to_owned(), "2.5".to_owned())
    );
    assert_eq!(slice_units(&"é".repeat(300), 200).chars().count(), 200);
}

#[test]
fn input_reports_field_issues_before_refinements() {
    let message = |p: Value| input(&p).err().map(|e| e.message);
    assert_eq!(
        message(json!({"from":1,"to":1,"x":1})).unwrap(),
        "params: Unrecognized key: \"x\"; params: to must be after from"
    );
    assert_eq!(
        message(json!({"from":5,"to":1,"bucket":"x"})).unwrap(),
        "bucket: Invalid option: expected one of \"day\"|\"week\""
    );
    assert_eq!(
        message(json!({"from":0,"to":34_560_001})).unwrap(),
        "params: period is limited to 400 days"
    );
    assert_eq!(
        message(json!({"from":-1,"to":0})).unwrap(),
        "from: Too small: expected number to be >=0; to: Too small: expected number to be >0"
    );
    assert!(message(json!({"from":0,"to":86400,"bucket":"week","repo":"r"})).is_none());
    assert!(insights_stays_forwarded(
        "insights.summary",
        &json!({"from":1e15,"to":1e15+1.0})
    ));
    assert!(!insights_stays_forwarded(
        "insights.summary",
        &json!({"from":1,"to":2})
    ));
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-2.5), -2.0);
}
