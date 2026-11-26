use super::{find, find_all};
use crate::public::Entry;
use serde_json::{Value, json};

fn entry(id: &str, bundled: bool, state: &str, contributes: Value) -> Entry {
    serde_json::from_value(json!({
        "id": id,
        "manifest": Some(json!({ "contributes": contributes })),
        "bundled": bundled,
        "grant": {},
        "state": state,
        "error": null,
        "pid": null,
        "served": [],
        "protocol": null,
        "restarts": 0,
    }))
    .expect("valid entry")
}

fn entry_without_manifest(id: &str, bundled: bool, state: &str) -> Entry {
    serde_json::from_value(json!({
        "id": id,
        "manifest": null,
        "bundled": bundled,
        "grant": {},
        "state": state,
        "error": null,
        "pid": null,
        "served": [],
        "protocol": null,
        "restarts": 0,
    }))
    .expect("valid entry")
}

#[test]
fn find_prefers_bundled_enabled_and_skips_disabled() {
    let entries = vec![
        entry(
            "z-installed",
            false,
            "ready",
            json!({ "assistant": {} }),
        ),
        entry("b-bundled", true, "idle", json!({ "assistant": {} })),
        entry("a-bundled", true, "failing", json!({ "assistant": {} })),
    ];
    // `failing` is not enabled; bundled shipping comes before installed ones.
    assert_eq!(find(&entries, "assistant", |_| true), Some("b-bundled".into()));
}

#[test]
fn find_skips_entries_without_a_manifest() {
    let entries = vec![
        entry_without_manifest("bare", true, "ready"),
        // A manifest without `contributes` also contributes nothing.
        entry("empty", false, "ready", json!({})),
    ];
    assert_eq!(find(&entries, "assistant", |_| true), None);
}

#[test]
fn find_filters_by_predicate_reading_the_contribution() {
    let entries = vec![
        entry(
            "planner-a",
            true,
            "ready",
            json!({ "assistant": { "backend": "claude" } }),
        ),
        entry(
            "planner-b",
            true,
            "ready",
            json!({ "assistant": { "backend": "executor" } }),
        ),
    ];
    let matches = find(&entries, "assistant", |c| c["backend"] == "executor");
    assert_eq!(matches, Some("planner-b".into()));
}

#[test]
fn find_all_orders_ids_by_utf16_code_units() {
    let entries = vec![
        entry("é", true, "ready", json!({ "assistant": {} })),
        entry("e", true, "ready", json!({ "assistant": {} })),
        entry("Z", true, "ready", json!({ "assistant": {} })),
    ];
    // `Array.prototype.sort` orders by code units: `Z` (0x5A) < `e` (0x65) < `é` (0xE9).
    assert_eq!(
        find_all(&entries, "assistant", |_| true),
        vec!["Z".to_string(), "e".to_string(), "é".to_string()]
    );
}

#[test]
fn find_all_filters_and_skips_manifestless() {
    let entries = vec![
        entry_without_manifest("bare", true, "ready"),
        entry(
            "planner-claude",
            false,
            "ready",
            json!({ "assistant": { "backend": "claude" } }),
        ),
        entry(
            "planner-exec",
            false,
            "ready",
            json!({ "assistant": { "backend": "executor" } }),
        ),
    ];
    assert_eq!(
        find_all(&entries, "assistant", |c| c["backend"] == "executor"),
        vec!["planner-exec".to_string()]
    );
}