#![allow(clippy::unwrap_used)]
//! B12-1 golden tests replaying the TypeScript-recorded fixtures
//! (`test/fixtures/m3/status/`) against the Rust pacer-status ports.
use pacer_status::{evidence, freshness, usage_store};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf};

fn cases(text: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(text)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn mark_freshness_matches_typescript() {
    for case in cases(include_str!(
        "../../../test/fixtures/m3/status/freshness.json"
    )) {
        let out = freshness::mark_freshness(
            &case["input"]["reading"],
            case["input"]["now"].as_f64().unwrap(),
        );
        assert_eq!(out, case["expected"], "{}", case["name"]);
    }
}

#[test]
fn reconcile_matches_typescript() {
    for case in cases(include_str!(
        "../../../test/fixtures/m3/status/evidence.json"
    )) {
        let i = &case["input"];
        let out = match case["name"].as_str().unwrap().split(':').next().unwrap() {
            "fact" => evidence::evidence_fact(
                &i["scope"],
                i["source"].as_str().unwrap(),
                i["observedAt"].as_f64(),
                i["validUntil"].as_f64(),
                i["reason"].as_str().unwrap(),
                i["value"].clone(),
                i["budgetPolicy"].as_str(),
            ),
            "reading" => {
                evidence::reading_evidence(&i["scope"], &i["reading"], i["usage"].as_str().unwrap())
            }
            "reconcile" => evidence::reconcile_evidence(
                &i["previous"],
                &i["incoming"],
                i["now"].as_f64().unwrap(),
                i["budgetPolicy"].as_str(),
            ),
            other => panic!("unknown case kind {other}"),
        };
        assert_eq!(out, case["expected"], "{}", case["name"]);
    }
}

#[test]
fn usage_store_matches_typescript() {
    for case in cases(include_str!(
        "../../../test/fixtures/m3/status/usage-store.json"
    )) {
        let i = &case["input"];
        let dir = tempfile::tempdir().unwrap();
        let pacer_home = dir.path().join(".pacer");
        let read_only = i.get("readOnly").and_then(Value::as_bool).unwrap_or(false);
        let mut ctx = pacer_foundation::Ctx::with(
            dir.path().to_path_buf(),
            pacer_home.clone(),
            HashMap::new(),
            0.0,
        );
        for w in i["writes"].as_array().unwrap() {
            ctx.now = w["now"].as_f64().unwrap();
            usage_store::write_usage_entry(
                &ctx,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                w["key"].as_str().unwrap(),
                &w["reading"],
                read_only,
            )
            .expect("write_usage_entry succeeded");
        }
        let path = pacer_home
            .join("state")
            .join("usage")
            .join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json");
        let bytes: Option<String> = std::fs::read_to_string(PathBuf::from(&path)).ok();
        assert_eq!(
            bytes.as_deref(),
            case["expected"]["bytes"].as_str(),
            "{}",
            case["name"]
        );
    }
}
