#![allow(clippy::unwrap_used)]

use pacer_lifecycle::{SlotLimits, parse_delegate_brief, queue_capacity, slot_use, validate_input};
use serde_json::{Value, json};

#[test]
fn brief_goldens() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/brief-goldens.json"
    ))
    .unwrap();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let actual = parse_delegate_brief(&case["raw"], "$REPO");
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
    assert!(validate_input(&input, true).is_empty());
    let input = json!({"brief":{"goal":" ","repo":"relative","acceptanceTimeoutMin":121}});
    assert_eq!(
        validate_input(&input, true),
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
