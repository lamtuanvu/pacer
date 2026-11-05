#![allow(clippy::unwrap_used)]

use pacer_lifecycle::{
    AdmissionValue, ExecutorResolution, SlotLimits, ValidationContext, parse_delegate_brief,
    parse_delegate_brief_json, queue_capacity, queue_capacity_for, slot_limit, slot_use,
    validate_input, validate_input_json,
};
use serde_json::{Value, json};

fn check(input: &Value) -> Vec<String> {
    let executor = match input["executor"].as_str() {
        Some("claude-code") => ExecutorResolution::Planner,
        Some("codex") => ExecutorResolution::Other,
        _ => ExecutorResolution::Unknown,
    };
    validate_input(
        input,
        true,
        &ValidationContext {
            configured_providers: &["claude-code", "codex"],
            executor,
        },
    )
}

#[test]
fn brief_goldens() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/brief-goldens.json"
    ))
    .unwrap();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let actual = parse_delegate_brief(&case["raw"], "$REPO");
        let lossless = parse_delegate_brief_json(&case["raw"].to_string(), "$REPO");
        assert_eq!(actual.is_ok(), lossless.is_ok(), "{id}");
        if let (Ok(actual), Ok(lossless)) = (&actual, lossless) {
            assert_eq!(
                *actual,
                serde_json::from_str::<Value>(&lossless.to_json()).unwrap(),
                "{id}"
            );
        }
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert!(actual.unwrap_err().to_string().contains(error), "{id}");
        } else {
            let actual = actual.unwrap();
            assert_eq!(actual["brief"], case["brief"], "{id} brief");
            assert_eq!(actual["input"], case["input"], "{id} input");
        }
    }
}

#[test]
fn capacity_goldens() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/capacity-goldens.json"
    ))
    .unwrap();
    for case in cases {
        let actual = queue_capacity(
            case["executor"].as_str().unwrap(),
            None,
            SlotLimits {
                executor: 1,
                host: None,
                local: None,
            },
            &case["use"],
            None,
        );
        assert_eq!(
            actual.unwrap_or(Value::Null),
            case["expected"],
            "{}",
            case["id"]
        );
    }
}

#[test]
fn slot_and_validation_edge_cases() {
    let tasks = vec![
        json!({"state":"running","executor":"codex"}),
        json!({"state":"needs_input","executor":"codex","live":true}),
        json!({"state":"needs_input","executor":"codex","live":true,"retriedBy":"next"}),
        json!({"state":"done","executor":"codex"}),
    ];
    assert_eq!(
        slot_use(&tasks),
        json!({"byExecutor":{"codex":2},"byHost":{},"local":2})
    );
    let input = json!({"brief":{"goal":" Check ","repo":"/tmp","acceptanceTimeoutMin":1}});
    assert!(check(&input).is_empty());
    let input = json!({"brief":{"goal":" ","repo":"relative","acceptanceTimeoutMin":121}});
    assert_eq!(
        check(&input),
        [
            "goal is required",
            "repo must be an absolute path",
            "acceptance_timeout_min must be an integer between 1 and 120"
        ]
    );
    assert!(parse_delegate_brief(&json!({"goal":"work","title":"   "}), "/tmp").is_err());
    assert_eq!(
        parse_delegate_brief(
            &json!({"goal":"work","title":"  task  ","admissionLease":"untrusted"}),
            "/tmp"
        )
        .unwrap()["input"],
        json!({"title":"task"})
    );
    assert_eq!(
        queue_capacity(
            "codex",
            Some("build"),
            SlotLimits {
                executor: 2,
                host: Some(1),
                local: None
            },
            &json!({"byExecutor":{"codex":1},"byHost":{"build":1},"local":0}),
            None
        ),
        Some(json!({"reason":"no_slot","limit":"host","capacity":{"used":1,"max":1}}))
    );
}

#[test]
fn slot_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/slot-goldens.json"
    ))
    .unwrap();
    for row in rows {
        assert_eq!(
            slot_use(row["tasks"].as_array().unwrap()),
            row["expected"],
            "{}",
            row["id"]
        );
    }
}

#[test]
fn capacity_branch_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/capacity-branches.json"
    ))
    .unwrap();
    for row in rows {
        let limits = &row["limits"];
        let actual = queue_capacity(
            row["executor"].as_str().unwrap(),
            row.get("host").and_then(Value::as_str),
            SlotLimits {
                executor: limits["executor"].as_u64().unwrap() as usize,
                host: limits["host"].as_u64().map(|n| n as usize),
                local: limits["local"].as_u64().map(|n| n as usize),
            },
            &row["use"],
            row.get("guard").cloned(),
        );
        assert_eq!(
            actual.unwrap_or(Value::Null),
            row["expected"],
            "{}",
            row["id"]
        );
    }
}

#[test]
fn slot_limit_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/slot-limit-goldens.json"
    ))
    .unwrap();
    for row in rows {
        let actual = slot_limit(&row["strategy"], row["runnerId"].as_str().unwrap());
        let expected = &row["expected"];
        assert_eq!(
            actual,
            SlotLimits {
                executor: expected["executor"].as_u64().unwrap() as usize,
                host: expected["host"].as_u64().map(|n| n as usize),
                local: expected["local"].as_u64().map(|n| n as usize),
            },
            "{}",
            row["id"]
        );
    }
}

#[test]
fn strategy_capacity_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/strategy-capacity-goldens.json"
    ))
    .unwrap();
    for row in rows {
        let actual = queue_capacity_for(
            &row["strategy"],
            row["executor"].as_str().unwrap(),
            &row["use"],
            row.get("guard").cloned(),
        );
        assert_eq!(
            actual.unwrap_or(Value::Null),
            row["expected"],
            "{}",
            row["id"]
        );
    }
}

#[test]
fn direct_validation_number_and_utf16_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/validation-goldens.json"
    ))
    .unwrap();
    for row in rows {
        assert_eq!(
            check(&row["input"]),
            row["problems"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect::<Vec<_>>(),
            "{}",
            row["id"]
        );
    }
}

#[test]
fn empty_default_repository_is_rejected() {
    assert!(parse_delegate_brief(&json!({"goal":"work"}), "").is_err());
}

#[test]
fn trim_and_numeric_goldens() {
    for file in [
        include_str!("../../../test/fixtures/task-admission/trim-goldens.json"),
        include_str!("../../../test/fixtures/task-admission/numeric-goldens.json"),
        include_str!("../../../test/fixtures/task-admission/string-length-goldens.json"),
    ] {
        let rows: Vec<Value> = serde_json::from_str(file).unwrap();
        for row in rows {
            let id = row["id"].as_str().unwrap();
            if let Some(raw) = row.get("raw") {
                let actual = parse_delegate_brief(raw, "/tmp");
                let lossless = parse_delegate_brief_json(&raw.to_string(), "/tmp");
                assert_eq!(actual.is_ok(), lossless.is_ok(), "{id}");
                if let (Ok(actual), Ok(lossless)) = (&actual, lossless) {
                    assert_eq!(
                        *actual,
                        serde_json::from_str::<Value>(&lossless.to_json()).unwrap(),
                        "{id}"
                    );
                }
                if row["accept"] == false {
                    assert!(actual.is_err(), "{id}");
                } else {
                    let parsed = actual.unwrap();
                    if let Some(title) = row.get("title") {
                        assert_eq!(&parsed["input"]["title"], title, "{id}");
                    }
                    if let Some(path) = row.get("outputPath").and_then(Value::as_array) {
                        let mut selected = &parsed;
                        for part in path {
                            selected = if let Some(key) = part.as_str() {
                                &selected[key]
                            } else {
                                &selected[part.as_u64().unwrap() as usize]
                            };
                        }
                        assert_eq!(selected, &row["expectedValue"], "{id} output");
                    }
                }
            }
            if let Some(input) = row.get("input") {
                let problems = check(input);
                assert_eq!(
                    problems.is_empty(),
                    row["accept"] == true,
                    "{id}: {problems:?}"
                );
            }
        }
    }
}

#[test]
fn surrogate_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/surrogate-goldens.json"
    ))
    .unwrap();
    for row in rows {
        if let Some(raw) = row["rawJson"].as_str() {
            let actual = parse_delegate_brief_json(raw, "/tmp");
            assert_eq!(
                actual.is_ok(),
                row["accept"] == true,
                "{}: {actual:?}",
                row["id"]
            );
            if let Some(expected) = row["expectedJson"].as_str() {
                let actual = actual.unwrap();
                assert_eq!(
                    actual,
                    AdmissionValue::parse(expected).unwrap(),
                    "{}",
                    row["id"]
                );
                assert_eq!(AdmissionValue::parse(&actual.to_json()).unwrap(), actual);
            }
        }
        if let Some(input) = row["inputJson"].as_str() {
            let problems = validate_input_json(
                input,
                true,
                &ValidationContext {
                    configured_providers: &["claude-code", "codex"],
                    executor: ExecutorResolution::Unknown,
                },
            )
            .unwrap();
            if let Some(expected) = row["problemsJson"].as_str() {
                let serialized = format!(
                    "[{}]",
                    problems
                        .iter()
                        .map(|s| s.to_json())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                assert_eq!(
                    AdmissionValue::parse(&serialized).unwrap(),
                    AdmissionValue::parse(expected).unwrap(),
                    "{}",
                    row["id"]
                );
            }
            assert_eq!(
                problems.is_empty(),
                row["accept"] == true,
                "{}: {problems:?}",
                row["id"]
            );
        }
    }
}

#[test]
fn pending_dependency_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/dependency-goldens.json"
    ))
    .unwrap();
    for row in rows {
        let strings = |value: &Value| -> Vec<String> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect()
        };
        let dependencies = strings(&row["dependencies"]);
        let waivers = strings(&row["waivers"]);
        let tasks: Vec<(String, Value)> = row["tasks"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, task)| (id.clone(), task.clone()))
            .collect();
        assert_eq!(
            pacer_lifecycle::pending_dependencies(&dependencies, &tasks, &waivers),
            strings(&row["expected"]),
            "{}",
            row["id"]
        );
    }
}

#[test]
fn work_lineage_inherits_parent_limits_and_requirements() {
    let task = json!({"brief":{"repo":"/repo"},"state":"running"});
    let root = pacer_lifecycle::work_node(
        "root",
        &task,
        &json!({
            "allowDelegation":true,"maxDepth":2,"maxDescendants":3,
            "requirements":{"minTier":"medium","context":100,"tools":true},"expiresAt":100
        }),
        &[],
        0,
    )
    .unwrap();
    let child = pacer_lifecycle::work_node(
        "child",
        &task,
        &json!({
            "requirements":{"minTier":"frontier","context":200},"maxDepth":10,"expiresAt":200
        }),
        &[(root.clone(), task.clone(), 0)],
        0,
    )
    .unwrap();
    assert_eq!(child["rootId"], "root");
    assert_eq!(child["parentId"], "root");
    assert_eq!(child["depth"], 1);
    assert_eq!(child["options"]["maxDepth"], 2);
    assert_eq!(
        child["options"]["requirements"],
        json!({"minTier":"frontier","context":200.0,"tools":true})
    );
    assert_eq!(child["options"]["expiresAt"], 100.0);
    assert!(
        pacer_lifecycle::work_node(
            "child",
            &task,
            &json!({"requirements":{"minTier":"small"}}),
            &[(root.clone(), task.clone(), 0)],
            0
        )
        .is_err()
    );
    assert!(
        pacer_lifecycle::work_node("child", &task, &json!({}), &[(root, task.clone(), 3)], 3)
            .is_err()
    );
}

#[test]
fn strategy_dependent_validation_matches_typescript() {
    // Let the authoritative TS strategy loader normalize the shared fixture,
    // then exercise Rust's complete runner-resolution-dependent validation.
    let script = r#"
      import {validateStrategy} from './src/config/strategy.ts';
      const rows=await Bun.file('./test/fixtures/task-admission/strategy-goldens.json').json();
      console.log(JSON.stringify(rows.map(row=>({...row,strategy:validateStrategy(row.strategy,'test')}))));
    "#;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("bun")
        .args(["-e", script])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for row in rows {
        let actual =
            pacer_lifecycle::validate_strategy_input(&row["strategy"], &row["input"], true);
        assert_eq!(serde_json::json!(actual), row["problems"], "{}", row["id"]);
    }
}
