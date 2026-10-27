#![allow(clippy::unwrap_used)]
use super::{requires_core_strategy_save_parser, save_op, save_op_with, yaml::render_draft};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, fs};

fn cases() -> Value {
    serde_json::from_str(include_str!(
        "../../../../test/fixtures/strategy-save/goldens.json"
    ))
    .unwrap()
}

fn fixture(case: &Value) -> (tempfile::TempDir, Ctx) {
    let temp = tempfile::tempdir().unwrap();
    let pacer = temp.path().join(".pacer");
    fs::create_dir_all(pacer.join("strategies")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(pacer.join("strategies"), fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(
        pacer.join("strategy.yaml"),
        case["initial"]["defaultYaml"].as_str().unwrap(),
    )
    .unwrap();
    fs::write(
        pacer.join("strategies/research.yaml"),
        case["initial"]["researchYaml"].as_str().unwrap(),
    )
    .unwrap();
    if case["initial"]["active"] == "research" {
        fs::write(pacer.join("active"), b"research\n").unwrap();
    }
    let ctx = Ctx::with(temp.path().into(), pacer, HashMap::new(), 1_700_000_000.0);
    (temp, ctx)
}

fn params(case: &Value) -> Value {
    json!({"name":case["name"],"draft":case["draft"],"reason":case["reason"],"overwrite":case["overwrite"]})
}

fn normalize(value: &mut Value, pacer: &str) {
    match value {
        Value::Array(rows) => rows.iter_mut().for_each(|row| normalize(row, pacer)),
        Value::Object(fields) => {
            for (key, item) in fields {
                if key == "id"
                    && item
                        .as_str()
                        .is_some_and(|id| id.starts_with("1700000000-"))
                {
                    *item = json!("<activity-id>");
                } else {
                    normalize(item, pacer);
                }
            }
        }
        Value::String(text) => *text = text.replace(pacer, "$PACER_HOME"),
        _ => {}
    }
}

fn json_lines(path: &std::path::Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .into_iter()
        .flat_map(|text| {
            text.lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<Value>>()
        })
        .collect()
}

#[test]
fn selected_typescript_save_goldens_have_identical_yaml_bytes() {
    let cases = cases();
    for case in cases.as_array().unwrap().iter().take(4) {
        let from = case["draft"]["from"].as_str().unwrap();
        let source = if from == "default" {
            case["initial"]["defaultYaml"].as_str().unwrap()
        } else {
            case["initial"]["researchYaml"].as_str().unwrap()
        };
        let yaml = render_draft(source, &case["draft"]).unwrap();
        let expected = case["saved"]
            .as_str()
            .unwrap()
            .splitn(3, '\n')
            .nth(2)
            .unwrap();
        assert_eq!(yaml, expected, "{}", case["id"]);
    }
}

#[tokio::test]
async fn selected_typescript_save_goldens_match_state_and_events() {
    let cases = cases();
    for case in cases.as_array().unwrap().iter().take(6) {
        let (_temp, ctx) = fixture(case);
        let params = params(case);
        assert!(
            !requires_core_strategy_save_parser(&ctx, &params),
            "{}",
            case["id"]
        );
        let mut outcome = match save_op(&ctx, params).await {
            Ok(result) => json!({"result":result}),
            Err(error) => {
                json!({"error":{"code":error.code,"message":error.message,"hint":error.hint}})
            }
        };
        normalize(&mut outcome, ctx.pacer_home.to_str().unwrap());
        assert_eq!(outcome, case["outcome"], "{}", case["id"]);
        let target = ctx
            .pacer_home
            .join("strategies")
            .join(format!("{}.yaml", case["name"].as_str().unwrap()));
        let saved = fs::read_to_string(&target).ok();
        assert_eq!(saved.as_deref(), case["saved"].as_str(), "{}", case["id"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(ctx.pacer_home.join("strategies"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                case["modes"]["strategies"].as_u64().unwrap() as u32
            );
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                case["modes"]["saved"].as_u64().unwrap() as u32
            );
        }
        let mut activity = json!(json_lines(&ctx.pacer_home.join("state/activity.jsonl")));
        normalize(&mut activity, ctx.pacer_home.to_str().unwrap());
        assert_eq!(activity, case["activity"], "{}", case["id"]);
        let mut outbox = json!(json_lines(&ctx.pacer_home.join("link/outbox.jsonl")));
        normalize(&mut outbox, ctx.pacer_home.to_str().unwrap());
        assert_eq!(outbox, case["outbox"], "{}", case["id"]);
    }
}

#[tokio::test]
async fn unsupported_draft_and_symlinked_target_forward_before_writing() {
    let cases = cases();
    let (temp, ctx) = fixture(&cases[0]);
    assert!(requires_core_strategy_save_parser(&ctx, &params(&cases[6])));
    let mut unsupported = params(&cases[0]);
    unsupported["draft"]["unset"] = json!(["pacing.policy"]);
    assert!(requires_core_strategy_save_parser(&ctx, &unsupported));
    unsupported = params(&cases[0]);
    unsupported["draft"]["set"] = json!({"pacing.unknown":42});
    assert!(requires_core_strategy_save_parser(&ctx, &unsupported));
    unsupported = params(&cases[0]);
    unsupported["reason"] = json!("x".repeat(4097));
    assert!(requires_core_strategy_save_parser(&ctx, &unsupported));
    fs::write(ctx.pacer_home.join("strategy.yaml"), "planner: codex\naccounts:\n  personal:\n    kind: codex\nrouting:\n  - default:\n      - codex\n").unwrap();
    assert!(requires_core_strategy_save_parser(&ctx, &params(&cases[0])));
    fs::write(
        ctx.pacer_home.join("strategy.yaml"),
        cases[0]["initial"]["defaultYaml"].as_str().unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = temp.path().join("outside.yaml");
        fs::write(&outside, b"untouched").unwrap();
        symlink(&outside, ctx.pacer_home.join("strategies/new-plan.yaml")).unwrap();
        assert!(requires_core_strategy_save_parser(&ctx, &params(&cases[0])));
        assert_eq!(fs::read(&outside).unwrap(), b"untouched");
        fs::remove_file(ctx.pacer_home.join("strategies/new-plan.yaml")).unwrap();
        fs::remove_dir_all(ctx.pacer_home.join("strategies")).unwrap();
        symlink(temp.path(), ctx.pacer_home.join("strategies")).unwrap();
        assert!(requires_core_strategy_save_parser(&ctx, &params(&cases[0])));
    }
}

#[tokio::test]
async fn activity_failure_keeps_saved_file_without_publishing() {
    let cases = cases();
    let (_temp, ctx) = fixture(&cases[0]);
    fs::create_dir_all(ctx.pacer_home.join("state/activity.jsonl")).unwrap();
    let error = save_op(&ctx, params(&cases[0])).await.unwrap_err();
    assert_eq!(error.code, pacer_foundation::api::error::Code::InvalidInput);
    assert!(ctx.pacer_home.join("strategies/new-plan.yaml").exists());
    assert!(!ctx.pacer_home.join("link/outbox.jsonl").exists());
}

#[tokio::test]
async fn active_and_named_drift_are_rechecked_after_selection() {
    let cases = cases();
    let (_temp, ctx) = fixture(&cases[3]);
    let error = save_op_with(&ctx, params(&cases[3]), || {
        fs::write(ctx.pacer_home.join("active"), b"research\n").unwrap();
    })
    .await
    .unwrap_err();
    assert!(error.message.contains("activeOk"));
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("strategies/research.yaml")).unwrap(),
        cases[3]["initial"]["researchYaml"].as_str().unwrap()
    );
    let (_temp, ctx) = fixture(&cases[0]);
    let competitor = cases[0]["initial"]["defaultYaml"].as_str().unwrap();
    let error = save_op_with(&ctx, params(&cases[0]), || {
        fs::write(ctx.pacer_home.join("strategies/new-plan.yaml"), competitor).unwrap();
    })
    .await
    .unwrap_err();
    assert!(error.message.contains("already exists"), "{error:?}");
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("strategies/new-plan.yaml")).unwrap(),
        competitor
    );
    let (_temp, ctx) = fixture(&cases[0]);
    let error = save_op_with(&ctx, params(&cases[0]), || {
        fs::write(
            ctx.pacer_home.join("strategies/new-plan.yaml"),
            b"malformed",
        )
        .unwrap();
    })
    .await
    .unwrap_err();
    assert_eq!(error.code, pacer_foundation::api::error::Code::Conflict);
    assert_eq!(
        fs::read(ctx.pacer_home.join("strategies/new-plan.yaml")).unwrap(),
        b"malformed"
    );
    let (_temp, ctx) = fixture(&cases[0]);
    let changed = "planner: codex\naccounts: {personal: {kind: codex}}\npacing: {planner_reserve: 25}\nrouting: [{default: [codex]}]\n";
    save_op_with(&ctx, params(&cases[0]), || {
        fs::write(ctx.pacer_home.join("strategy.yaml"), changed).unwrap();
    })
    .await
    .unwrap();
    let saved = fs::read_to_string(ctx.pacer_home.join("strategies/new-plan.yaml")).unwrap();
    assert!(saved.contains("planner_reserve: 25"));
    assert!(saved.contains("Codex keeps 25%"));
}

#[tokio::test]
async fn shared_strategy_lock_defers_save_and_rechecks_target() {
    use std::time::Duration;
    let cases = cases();
    let (_temp, ctx) = fixture(&cases[0]);
    fs::create_dir_all(ctx.pacer_home.join("orca")).unwrap();
    let lock = ctx.pacer_home.join("orca/strategy.lock");
    let target = ctx.pacer_home.join("strategies/new-plan.yaml");
    fs::write(&lock, b"held").unwrap();
    let params = params(&cases[0]);
    let task = tokio::spawn({
        let ctx = ctx.clone();
        async move { save_op(&ctx, params).await }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(!target.exists());
    let competitor = cases[0]["initial"]["defaultYaml"].as_str().unwrap();
    fs::write(&target, competitor).unwrap();
    fs::remove_file(&lock).unwrap();
    let error = task.await.unwrap().unwrap_err();
    assert!(error.message.contains("already exists"), "{error:?}");
    assert_eq!(fs::read_to_string(target).unwrap(), competitor);
}

#[cfg(unix)]
#[tokio::test]
async fn overwrite_replaces_inode_and_removes_exclusive_temp() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let cases = cases();
    let (_temp, ctx) = fixture(&cases[3]);
    let dir = ctx.pacer_home.join("strategies");
    let target = dir.join("research.yaml");
    let before = fs::metadata(&target).unwrap().ino();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    save_op(&ctx, params(&cases[3])).await.unwrap();
    assert_ne!(fs::metadata(&target).unwrap().ino(), before);
    assert_eq!(
        fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::read_to_string(target).unwrap(),
        cases[3]["saved"].as_str().unwrap()
    );
    assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
}
