#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_lifecycle::{JsText, attention, clients, hosts, jobs, notify};
use serde_json::{Value, json};
fn job() -> Value {
    json!({"id":"j","kind":"host.check","target":"host","state":"running","steps":[{"name":"A","state":"running"},{"name":"B","state":"pending"}],"startedAt":1,"pid":42,"cancellable":true})
}
#[test]
fn waking_client_renews_without_changing_notifier_priority() {
    let mut rows = vec![];
    let options = json!({"kind":"desktop","version":"1","notifier":true});
    clients::register(&mut rows, &options, "first", 0.0);
    clients::register(&mut rows, &options, "second", 0.0);
    clients::heartbeat(&mut rows, "first", 30.0).unwrap();
    assert_eq!(clients::active(&rows, 45.0)["client_id"], "second");
    assert_eq!(clients::active(&rows, 45.000001)["client_id"], "first");
    assert!(clients::active(&rows, 75.000001).is_null());
}
#[test]
fn registration_retains_one_day_boundary_and_discards_older_entries() {
    let options = json!({"kind":"app","version":"1"});
    let mut rows = vec![];
    clients::register(&mut rows, &options, "old", 0.0);
    clients::register(&mut rows, &options, "boundary", 86400.0);
    assert_eq!(rows.len(), 2);
    clients::register(&mut rows, &options, "next", 86400.000001);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["client_id"], "boundary");
}
#[test]
fn one_malformed_client_discards_entire_read_but_unknown_heartbeat_does_not_create() {
    let row = json!({"kind":"app","version":"1","client_id":"good","registeredAt":0,"heartbeatAt":0,"notifier":true});
    assert_eq!(clients::read(&json!([row.clone()])).len(), 1);
    assert!(clients::read(&json!([row,{"client_id":"bad"}])).is_empty());
    let mut rows = vec![];
    assert_eq!(
        clients::heartbeat(&mut rows, "missing", 1.0)
            .unwrap_err()
            .code,
        "invalid_input"
    );
    assert!(rows.is_empty());
}
#[test]
fn cancellation_settles_steps_and_cannot_be_overwritten_by_late_completion() {
    let original = job();
    let cancelled = jobs::cancel(&original, 2.5).unwrap();
    assert_eq!(cancelled["endedAt"], 2.5);
    assert_eq!(cancelled["steps"][0]["state"], "skipped");
    assert_eq!(
        jobs::finish(&original, &cancelled, 3.0, false, None),
        cancelled
    );
    let mut stale = original.clone();
    jobs::update(&mut stale, &cancelled, "missing", "passed", None).unwrap();
    assert_eq!(stale, original);
}
#[test]
fn failed_running_jobs_keep_failed_steps_and_skip_pending() {
    let (recovered, action) = jobs::recover(&job(), 2.25, "1", false, false);
    assert_eq!(action, jobs::Recovery::Save);
    assert_eq!(recovered["steps"][0]["state"], "failed");
    assert_eq!(recovered["steps"][1]["state"], "skipped");
    assert_eq!(recovered["error"]["code"], "interrupted");
}
#[test]
fn version_matched_restart_precedes_live_pid_and_handover_uses_latest_snapshot() {
    let mut original = job();
    original["kind"] = "update.apply".into();
    original["steps"] = json!([{"name":"Restart","state":"running","detail":"1.0"},{"name":"Later","state":"pending"}]);
    assert_eq!(
        jobs::recover(&original, 2.0, "1.0", true, true).1,
        jobs::Recovery::Handover
    );
    assert_eq!(
        jobs::recover(&original, 2.0, "1.0", true, false).0["state"],
        "passed"
    );
    let cancelled = jobs::cancel(&original, 2.0).unwrap();
    assert_eq!(
        jobs::finish_restart(&cancelled, 3.0, "done", false),
        cancelled
    );
    assert_eq!(
        jobs::finish_restart(&original, 3.0, "done", false)["steps"][1]["state"],
        "pending"
    );
}
#[test]
fn job_retention_and_deduplication_use_started_at_and_exact_running_target() {
    let mut original = job();
    original["state"] = "passed".into();
    assert!(jobs::retained(&original, 86401.0));
    assert!(!jobs::retained(&original, 86401.000001));
    assert_eq!(
        jobs::existing(&[job()], "host.check", "host", 90000.0),
        Some(job())
    );
    assert!(jobs::existing(&[job()], "runner.check", "host", 1.0).is_none());
    assert!(jobs::valid_id("a-Z-1"));
    for id in ["", "../a", "a.json", "a/b"] {
        assert!(!jobs::valid_id(id));
    }
    for pid in [0.0, -1.0, 0.5, f64::INFINITY, f64::NAN] {
        assert!(!jobs::query_pid(pid));
    }
}
#[test]
fn failed_step_with_empty_detail_fails_and_restart_intent_does_not_settle() {
    let mut original = job();
    original["steps"][0]["state"] = "failed".into();
    original["steps"][0]["detail"] = "".into();
    let done = jobs::finish(&original, &original, 2.0, false, None);
    assert_eq!(done["state"], "failed");
    assert_eq!(done["error"]["message"], "");
    original["steps"] = json!([{"name":"Restart","state":"running"}]);
    assert_eq!(
        jobs::finish(&original, &original, 2.0, true, None)["state"],
        "running"
    );
}
#[test]
fn attention_store_preserves_task_raised_time_and_clears_resolved_conditions() {
    let item = attention::Item::from_value(
        &json!({"id":"failed:t","kind":"failed","severity":"problem","taskId":"t","title":"Task","detail":"detail","since":1,"raisedAt":1}),
    );
    let mut store = json!({});
    let out = attention::apply(&mut store, vec![item.clone()], 10.5);
    assert_eq!(out[0].get("since"), 10.5);
    assert_eq!(out[0].get("raisedAt"), 1);
    attention::dismiss(&mut store, "failed:t", std::slice::from_ref(&item), 11.0).unwrap();
    assert!(attention::apply(&mut store, vec![item.clone()], 12.0).is_empty());
    attention::apply(&mut store, vec![], 13.0);
    assert_eq!(
        attention::apply(&mut store, vec![item], 14.0)[0].get("since"),
        14.0
    );
}
#[test]
fn utf16_serialization_preserves_a_split_surrogate() {
    let text = JsText::new("a😀b").slice(2);
    assert_eq!(text.0, vec![0x61, 0xd83d]);
    assert_eq!(serde_json::to_string(&text).unwrap(), r#""\u0061\ud83d""#);
}
#[test]
fn notifier_suppresses_duplicate_candidates_and_seven_day_boundary_is_inclusive() {
    let item = attention::Item::from_value(
        &json!({"id":"question:t","title":"Question","detail":"question","since":0.0000001,"notify":"important","taskId":"a/b", "actions":[]}),
    );
    let out = notify::candidates(&[item.clone(), item.clone()], "important", &json!({}));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].key, "question:t:1e-7");
    assert_eq!(out[0].data.url, "/app/#/tasks/a%2Fb");
    assert!(notify::candidates(&[item], "all", &json!({"question:t:1e-7":0})).is_empty());
    assert_eq!(
        notify::retain(&json!({"boundary":0,"old":-0.1,"string":"3"}), 604800.0),
        json!({"boundary":0})
    );
}
#[test]
fn clone_consent_is_bound_to_all_snapshot_fields() {
    let snapshot = json!({"alias":"h","key":"github.com/acme/api","path":"~/repo","origin":"git@github.com:acme/api.git","hostFingerprint":"one"});
    hosts::validate_clone_preview(&snapshot, &snapshot).unwrap();
    for key in ["alias", "key", "path", "origin", "hostFingerprint"] {
        let mut preview = snapshot.clone();
        preview[key] = "changed".into();
        assert_eq!(
            hosts::validate_clone_preview(&snapshot, &preview)
                .unwrap_err()
                .code,
            "capability_denied"
        );
    }
}
#[test]
fn repo_identity_accepts_supported_git_transports_and_rejects_secrets_and_nested_paths() {
    for origin in [
        "git@github.com:ACME/API.git",
        "https://github.com/acme/api.git",
        "ssh://git@github.com/acme/api",
    ] {
        assert_eq!(
            hosts::repo_key(origin).as_deref(),
            Some("github.com/acme/api")
        );
    }
    for origin in [
        "http://github.com/acme/api",
        "https://x:password@github.com/acme/api",
        "https://github.com/acme/api?x=1",
        "https://github.com/acme/api/extra",
    ] {
        assert!(hosts::repo_key(origin).is_none(), "{origin}");
    }
}
