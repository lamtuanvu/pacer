#![allow(clippy::unwrap_used)]
use pacer_config::{requires_core_routing_set_parser, routing_set_ops};
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
async fn supported_routing_edits_match_typescript_bytes_and_events() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/routing-set/goldens.json"
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
        if id == "active-named" {
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
        let params = json!({"rules":case["rules"]});
        let selected = matches!(
            id,
            "same-length-block"
                | "unchanged-default"
                | "same-length-flow"
                | "same-length-crlf"
                | "active-named"
        );
        assert_eq!(
            requires_core_routing_set_parser(&ctx, &params),
            !selected,
            "{id}"
        );
        if !selected {
            continue;
        }
        let op = routing_set_ops()
            .iter()
            .find(|op| op.name == "routing.set")
            .unwrap();
        let outcome = match (op.call)(&ctx, params).await {
            Ok(result) => json!({"result":result}),
            Err(error) => {
                json!({"error":{"code":error.code,"message":error.message,"hint":error.hint}})
            }
        };
        let home = pacer.to_str().unwrap();
        let mut outcome = outcome;
        normalize(&mut outcome, home);
        assert_eq!(outcome, case["outcome"], "{id}");
        let edited = if id == "active-named" {
            pacer.join("strategies/research.yaml")
        } else {
            pacer.join("strategy.yaml")
        };
        assert_eq!(fs::read_to_string(edited).unwrap(), case["edited"], "{id}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let edited = if id == "active-named" {
                pacer.join("strategies/research.yaml")
            } else {
                pacer.join("strategy.yaml")
            };
            assert_eq!(
                fs::metadata(edited).unwrap().permissions().mode() & 0o777,
                case["mode"].as_u64().unwrap() as u32,
                "{id}"
            );
        }
        assert_eq!(
            fs::read_to_string(pacer.join("opencode/opencode.json")).unwrap(),
            case["opencode"]
        );
        let mut activity = json!(lines(&pacer.join("state/activity.jsonl")));
        let mut outbox = json!(lines(&pacer.join("link/outbox.jsonl")));
        normalize(&mut activity, home);
        normalize(&mut outbox, home);
        assert_eq!(activity, case["activity"]);
        assert_eq!(outbox, case["outbox"]);
    }
}
