#![allow(clippy::unwrap_used)]
use pacer_config::{requires_core_runner_parser, runner_config_ops};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, fs};

fn normalize(value: &mut Value, home: &str) {
    match value {
        Value::Array(rows) => rows.iter_mut().for_each(|row| normalize(row, home)),
        Value::Object(fields) => {
            for (key, item) in fields {
                if key == "id"
                    && item
                        .as_str()
                        .is_some_and(|id| id.starts_with("1700000000-"))
                {
                    *item = json!("<activity-id>");
                } else {
                    normalize(item, home);
                }
            }
        }
        Value::String(text) => *text = text.replace(home, "$PACER_HOME"),
        _ => {}
    }
}
fn lines(path: &std::path::Path) -> Vec<Value> {
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

#[tokio::test]
async fn supported_runner_edits_match_typescript_bytes_and_events() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/runner-config/goldens.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let pacer = temp.path().join(".pacer");
        fs::create_dir_all(&pacer).unwrap();
        fs::write(
            pacer.join("strategy.yaml"),
            case["initial"].as_str().unwrap(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                pacer.join("strategy.yaml"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        if id == "reorder-named" {
            fs::create_dir_all(pacer.join("strategies")).unwrap();
            fs::write(
                pacer.join("strategies/research.yaml"),
                case["initial"].as_str().unwrap(),
            )
            .unwrap();
            fs::write(pacer.join("active"), "research\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    pacer.join("strategies/research.yaml"),
                    fs::Permissions::from_mode(0o600),
                )
                .unwrap();
            }
        }
        let ctx = Ctx::with(
            temp.path().into(),
            pacer.clone(),
            HashMap::new(),
            1_700_000_000.0,
        );
        let op_name = case["op"].as_str().unwrap();
        let params = case["params"].clone();
        let selected = !matches!(id, "reorder-invalid" | "set-planner-refusal");
        assert_eq!(
            requires_core_runner_parser(&ctx, op_name, &params),
            !selected,
            "{id}"
        );
        if !selected {
            continue;
        }
        let op = runner_config_ops()
            .iter()
            .find(|op| op.name == op_name)
            .unwrap();
        let mut outcome = match (op.call)(&ctx, params).await {
            Ok(result) => json!({"result":result}),
            Err(error) => {
                json!({"error":{"code":error.code,"message":error.message,"hint":error.hint}})
            }
        };
        let home = pacer.to_str().unwrap();
        normalize(&mut outcome, home);
        assert_eq!(outcome, case["outcome"], "{id}");
        let path = if id == "reorder-named" {
            pacer.join("strategies/research.yaml")
        } else {
            pacer.join("strategy.yaml")
        };
        assert_eq!(fs::read_to_string(&path).unwrap(), case["edited"], "{id}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                case["mode"].as_u64().unwrap() as u32,
                "{id}"
            );
        }
        assert_eq!(
            fs::read_to_string(pacer.join("opencode/opencode.json")).unwrap(),
            case["opencode"],
            "{id}"
        );
        let mut activity = json!(lines(&pacer.join("state/activity.jsonl")));
        let mut outbox = json!(lines(&pacer.join("link/outbox.jsonl")));
        normalize(&mut activity, home);
        normalize(&mut outbox, home);
        assert_eq!(activity, case["activity"], "{id}");
        assert_eq!(outbox, case["outbox"], "{id}");
    }
}

#[test]
fn unsupported_account_names_remain_core_owned() {
    let temp = tempfile::tempdir().unwrap();
    let pacer = temp.path().join(".pacer");
    fs::create_dir_all(&pacer).unwrap();
    let yaml = "planner: claude-code\naccounts:\n  Personal Account: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrouting:\n  - default: [codex, cursor]\npacing: {order: [codex, cursor], policy: priority}\n";
    fs::write(pacer.join("strategy.yaml"), yaml).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            pacer.join("strategy.yaml"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let ctx = Ctx::with(
        temp.path().into(),
        pacer.clone(),
        HashMap::new(),
        1_700_000_000.0,
    );
    assert!(requires_core_runner_parser(
        &ctx,
        "runner.reorder",
        &json!({"ids":["cursor","codex"]})
    ));
    assert_eq!(
        fs::read_to_string(pacer.join("strategy.yaml")).unwrap(),
        yaml
    );
}
