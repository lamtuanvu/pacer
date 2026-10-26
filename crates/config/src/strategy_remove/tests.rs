#![allow(clippy::unwrap_used)]
use super::*;
use pacer_foundation::{Ctx, api::error::Code};
use serde_json::{Value, json};
use std::{collections::HashMap, fs};

fn fixture(case: &Value) -> (tempfile::TempDir, Ctx) {
    let temp = tempfile::tempdir().unwrap();
    let pacer = temp.path().join(".pacer");
    fs::create_dir_all(pacer.join("strategies")).unwrap();
    fs::write(
        pacer.join("strategy.yaml"),
        case["defaultYaml"].as_str().unwrap(),
    )
    .unwrap();
    fs::write(
        pacer.join("strategies/research.yaml"),
        case["researchYaml"].as_str().unwrap(),
    )
    .unwrap();
    if case["initial"] == "research" {
        fs::write(pacer.join("active"), b"research\n").unwrap();
    }
    let ctx = Ctx::with(temp.path().into(), pacer, HashMap::new(), 1_700_000_000.0);
    (temp, ctx)
}

fn normalize_ids(value: &mut Value) {
    match value {
        Value::Array(rows) => rows.iter_mut().for_each(normalize_ids),
        Value::Object(fields) => {
            for (key, item) in fields {
                if key == "id"
                    && item
                        .as_str()
                        .is_some_and(|id| id.starts_with("1700000000-"))
                {
                    *item = json!("<activity-id>");
                } else {
                    normalize_ids(item);
                }
            }
        }
        _ => {}
    }
}

#[tokio::test]
async fn typescript_remove_goldens_match_files_events_and_refusals() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-remove/goldens.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let (_temp, ctx) = fixture(case);
        let params = json!({"name":case["target"]});
        if case["id"] == "missing-named" {
            assert!(requires_core_strategy_remove_parser(&ctx, &params));
            continue;
        }
        let outcome = match remove_op(&ctx, params).await {
            Ok(result) => json!({"result":result}),
            Err(error) => {
                json!({"error":{"code":error.code,"message":error.message,"hint":error.hint}})
            }
        };
        assert_eq!(outcome, case["outcome"], "{}", case["id"]);
        let remaining = fs::read_to_string(ctx.pacer_home.join("strategies/research.yaml")).ok();
        assert_eq!(remaining.as_deref(), case["remaining"].as_str());
        let active = fs::read_to_string(ctx.pacer_home.join("active")).ok();
        assert_eq!(active.as_deref(), case["active"].as_str());
        let mut activity: Vec<Value> =
            fs::read_to_string(ctx.pacer_home.join("state/activity.jsonl"))
                .ok()
                .into_iter()
                .flat_map(|text| {
                    text.lines()
                        .map(|line| serde_json::from_str(line).unwrap())
                        .collect::<Vec<Value>>()
                })
                .collect();
        activity.iter_mut().for_each(normalize_ids);
        assert_eq!(activity, *case["activity"].as_array().unwrap());
        let mut outbox: Vec<Value> = fs::read_to_string(ctx.pacer_home.join("link/outbox.jsonl"))
            .ok()
            .into_iter()
            .flat_map(|text| {
                text.lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect();
        outbox.iter_mut().for_each(normalize_ids);
        assert_eq!(outbox, *case["outbox"].as_array().unwrap());
        let latest: Option<Value> = fs::read(ctx.pacer_home.join("link/latest.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap());
        assert_eq!(latest, case.get("latest").filter(|v| !v.is_null()).cloned());
    }
}

#[tokio::test]
async fn active_target_is_not_deleted() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-remove/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&cases[1]);
    let error = remove_op(&ctx, json!({"name":"research"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert!(ctx.pacer_home.join("strategies/research.yaml").exists());
}

#[tokio::test]
async fn activity_append_failure_leaves_named_file_deleted() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-remove/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&cases[0]);
    fs::create_dir_all(ctx.pacer_home.join("state/activity.jsonl")).unwrap();
    let error = remove_op(&ctx, json!({"name":"research"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert!(!ctx.pacer_home.join("strategies/research.yaml").exists());
    assert!(!ctx.pacer_home.join("link/outbox.jsonl").exists());
}

#[tokio::test]
async fn active_switch_before_lock_refuses_deletion() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-remove/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&cases[0]);
    let error = remove_op_with(&ctx, json!({"name":"research"}), || {
        fs::write(ctx.pacer_home.join("active"), b"research\n").unwrap();
    })
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(error.message, "cannot delete the active strategy");
    assert!(ctx.pacer_home.join("strategies/research.yaml").exists());
    assert!(!ctx.pacer_home.join("link/outbox.jsonl").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_named_file_forwards_without_touching_target() {
    use std::os::unix::fs::symlink;
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-remove/goldens.json"
    ))
    .unwrap();
    let (temp, ctx) = fixture(&cases[0]);
    let target = temp.path().join("outside.yaml");
    fs::write(&target, b"untouched").unwrap();
    fs::remove_file(ctx.pacer_home.join("strategies/research.yaml")).unwrap();
    symlink(&target, ctx.pacer_home.join("strategies/research.yaml")).unwrap();
    assert!(requires_core_strategy_remove_parser(
        &ctx,
        &json!({"name":"research"})
    ));
    assert_eq!(fs::read(target).unwrap(), b"untouched");
}
