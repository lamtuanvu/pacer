use super::*;
use serde_json::json;

#[test]
fn actionable_attention_replaces_the_legacy_count() {
    let mut snapshot = json!({
        "at": 100, "counts": {"running": 2, "attention": 99},
        "tasks": [
            {"id": "done", "state": "done"},
            {"id": "requested", "state": "done", "reviewRequest": {"at": 90}},
            {"id": "reviewed", "state": "done", "reviewRequest": {"at": 90}, "review": {}},
            {"id": "partial", "state": "partial"},
            {"id": "failed", "state": "done", "acceptanceState": "failed"}
        ],
        "attention": [
            {"kind": "host_down"},
            {"kind": "review", "taskId": "done"},
            {"kind": "review", "taskId": "requested"},
            {"kind": "review", "taskId": "reviewed"},
            {"kind": "review", "taskId": "partial"},
            {"kind": "review", "taskId": "failed"},
            {"kind": "review", "taskId": "outside-snapshot"},
            {"id": "run_review:done", "kind": "review", "taskId": "done"},
            {"id": "run_review:reviewed", "kind": "review", "taskId": "reviewed"},
            {"kind": "failed", "snoozedUntil": 101}
        ]
    });
    assert_eq!(counts(&snapshot)["running"], 2);
    assert_eq!(counts(&snapshot)["attention"], 6);
    snapshot["at"] = json!(101);
    assert_eq!(counts(&snapshot)["attention"], 7);
}

#[test]
fn old_services_without_attention_keep_the_count() {
    let snapshot = json!({"counts": {"attention": 7, "running": 1}});
    assert_eq!(counts(&snapshot)["attention"], 7);
    assert!(counts(&json!({"attention": []})).is_null());
}
