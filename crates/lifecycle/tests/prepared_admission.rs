#![allow(clippy::unwrap_used)]

use pacer_lifecycle::{
    DelegateAdmissionSnapshot, PolicyAmendment, admission_context_same, map_policy_amendment,
    prepare_delegate_admission,
};
use serde_json::{Value, json};

#[test]
fn prepared_admission_goldens() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/prepared-admission-goldens.json"
    ))
    .unwrap();
    for row in rows {
        let id = row["id"].as_str().unwrap();
        if let Some(amend) = row.get("amend") {
            let mapped = map_policy_amendment(&row["input"], &PolicyAmendment::from_value(amend));
            assert_eq!(mapped, row["mapped"], "{id}");
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let strategy = row["strategy"].clone();
        let mut brief = row["brief"].clone();
        if brief["repo"] == "$REPO" {
            brief["repo"] = json!(repo);
        }
        let mut raw = json!({ "goal": brief["goal"], "repo": brief["repo"] });
        if let Some(executor) = brief.get("executor").filter(|v| !v.is_null()) {
            raw["executor"] = executor.clone();
        }
        let strategy_for_closure = strategy.clone();
        let result = prepare_delegate_admission(
            &raw,
            repo.to_str().unwrap(),
            &[],
            None,
            move || {
                Ok(DelegateAdmissionSnapshot {
                    strategy: strategy_for_closure.clone(),
                    projects: json!({"version":1,"projects":{}}),
                    repo: Value::Null,
                    exclusions: json!({}),
                    registered: None,
                    parent: None,
                    work: None,
                    root: None,
                    active: None,
                    candidates: None,
                    context: None,
                })
            },
            |input| Ok(input.clone()),
        );
        if row["accept"] == true {
            assert!(result.is_ok(), "{id}: {:?}", result.as_ref().err());
        } else {
            let error = result.as_ref().err().unwrap().to_string();
            assert!(
                error.contains(row["error"].as_str().unwrap()),
                "{id}: {error}"
            );
        }
    }
}

#[test]
fn admission_context_goldens_use_library_helper() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/context-goldens.json"
    ))
    .unwrap();
    for row in rows {
        let a: Value = serde_json::from_str(row["aJson"].as_str().unwrap()).unwrap();
        let b: Value = serde_json::from_str(row["bJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            admission_context_same(&a, &b).unwrap(),
            row["same"].as_bool().unwrap(),
            "{}",
            row["id"]
        );
    }
}
