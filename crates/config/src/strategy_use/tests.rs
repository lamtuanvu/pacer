#![allow(clippy::unwrap_used)]
use super::*;
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
    let ctx = Ctx::with(
        temp.path().to_owned(),
        pacer,
        HashMap::new(),
        1_700_000_000.0,
    );
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
async fn typescript_use_goldens_match_result_state_and_event_order() {
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-use/goldens.json"
    ))
    .unwrap();
    for case in goldens.as_array().unwrap() {
        let (_temp, ctx) = fixture(case);
        let name = case["target"].as_str().unwrap();
        let result = use_op(&ctx, json!({"name":name})).await.unwrap();
        assert_eq!(result["name"], case["result"]["name"]);
        let path = result["path"].as_str().unwrap();
        assert_eq!(
            path.replace(ctx.pacer_home.to_str().unwrap(), "$PACER_HOME"),
            case["result"]["path"]
        );
        let active = fs::read_to_string(ctx.pacer_home.join("active")).ok();
        assert_eq!(active.as_deref(), case["active"].as_str());
        let mut rows: Vec<Value> = fs::read_to_string(ctx.pacer_home.join("link/outbox.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        rows.iter_mut().for_each(normalize_ids);
        assert_eq!(rows, *case["outbox"].as_array().unwrap());
        let mut activity: Vec<Value> =
            fs::read_to_string(ctx.pacer_home.join("state/activity.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        activity.iter_mut().for_each(normalize_ids);
        assert_eq!(activity, *case["activity"].as_array().unwrap());
        let latest: Value =
            serde_json::from_slice(&fs::read(ctx.pacer_home.join("link/latest.json")).unwrap())
                .unwrap();
        assert_eq!(latest, case["latest"]);
    }
}

#[tokio::test]
async fn unsupported_yaml_stays_with_core_without_writing() {
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-use/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&goldens[0]);
    fs::write(
        ctx.pacer_home.join("strategies/research.yaml"),
        "planner: [unsupported]\n",
    )
    .unwrap();
    assert!(requires_core_strategy_use_parser(
        &ctx,
        &json!({"name":"research"})
    ));
    assert!(!ctx.pacer_home.join("active").exists());
}

#[tokio::test]
async fn missing_and_invalid_names_forward_without_side_effects() {
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-use/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&goldens[0]);
    for params in [
        json!({"name":"missing"}),
        json!({"name":"../outside"}),
        json!({"name":42}),
        Value::Null,
    ] {
        assert!(requires_core_strategy_use_parser(&ctx, &params));
    }
    assert!(!ctx.pacer_home.join("active").exists());
    assert!(!ctx.pacer_home.join("link/outbox.jsonl").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn named_use_privates_directory_and_file() {
    use std::os::unix::fs::PermissionsExt;
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-use/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&goldens[0]);
    fs::set_permissions(&ctx.pacer_home, fs::Permissions::from_mode(0o755)).unwrap();
    use_op(&ctx, json!({"name":"research"})).await.unwrap();
    assert_eq!(
        fs::read(ctx.pacer_home.join("active")).unwrap(),
        b"research\n"
    );
    assert_eq!(
        fs::metadata(&ctx.pacer_home).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(ctx.pacer_home.join("active"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_active_forwards_without_writing_target() {
    use std::os::unix::fs::symlink;
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-use/goldens.json"
    ))
    .unwrap();
    let (temp, ctx) = fixture(&goldens[0]);
    let target = temp.path().join("outside");
    fs::write(&target, "untouched").unwrap();
    symlink(&target, ctx.pacer_home.join("active")).unwrap();
    assert!(requires_core_strategy_use_parser(
        &ctx,
        &json!({"name":"research"})
    ));
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
}

#[tokio::test]
async fn active_change_between_observation_and_lock_conflicts_without_events() {
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-use/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&goldens[0]);
    let error = use_op_with(&ctx, json!({"name":"research"}), || {
        fs::write(ctx.pacer_home.join("active"), "research\n").unwrap();
    })
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.message, "active strategy changed; retry");
    assert_eq!(
        fs::read(ctx.pacer_home.join("active")).unwrap(),
        b"research\n"
    );
    assert!(!ctx.pacer_home.join("link/outbox.jsonl").exists());
    assert!(!ctx.pacer_home.join("state/activity.jsonl").exists());
}

#[tokio::test]
async fn activity_append_failure_keeps_prior_switch_and_alert() {
    let goldens: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-use/goldens.json"
    ))
    .unwrap();
    let (_temp, ctx) = fixture(&goldens[0]);
    fs::create_dir_all(ctx.pacer_home.join("state/activity.jsonl")).unwrap();
    let error = use_op(&ctx, json!({"name":"research"})).await.unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(
        fs::read(ctx.pacer_home.join("active")).unwrap(),
        b"research\n"
    );
    let outbox = fs::read_to_string(ctx.pacer_home.join("link/outbox.jsonl")).unwrap();
    let rows: Vec<Value> = outbox
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["envelope"]["type"], "alert");
}
