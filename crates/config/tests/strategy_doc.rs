#![allow(clippy::unwrap_used)]

use pacer_config::doc::StrategyDoc;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Case {
    id: String,
    classes: Vec<String>,
    before: String,
    after: String,
    op: String,
    path: Vec<Value>,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[test]
fn committed_strategy_doc_corpus() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-doc/goldens.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let mut doc = StrategyDoc::new(&case.before);
        let result = match case.op.as_str() {
            "getIn" => doc.get_in(&case.path).map(|value| {
                value.map_or(
                    json!({"found": false}),
                    |value| json!({"found": true, "value": value}),
                )
            }),
            "setIn" | "setScalar" => doc.set_in(&case.path, &case.value).map(|()| Value::Null),
            "deleteIn" => doc.delete_in(&case.path).map(|()| Value::Null),
            "addMappingEntry" => doc
                .add_mapping_entry(
                    case.path[0].as_str().unwrap(),
                    case.path[1].as_str().unwrap(),
                    &case.value,
                )
                .map(|()| Value::Null),
            "removeMappingEntry" => doc
                .remove_mapping_entry(
                    case.path[0].as_str().unwrap(),
                    case.path[1].as_str().unwrap(),
                )
                .map(|()| Value::Null),
            "setList" => doc
                .set_list(&case.path, case.value.as_array().unwrap())
                .map(|()| Value::Null),
            "renameKey" => doc
                .rename_key(&case.path, case.value.as_str().unwrap())
                .map(|()| Value::Null),
            "replaceNode" => doc
                .replace_node(&case.path, &case.value)
                .map(|()| Value::Null),
            other => panic!("unknown op: {other}"),
        };
        let actual_error = result.as_ref().err().map(ToString::to_string);
        let actual_result = if case.op == "getIn" {
            result.ok()
        } else {
            None
        };
        if doc.as_str() != case.after || actual_error != case.error || actual_result != case.result
        {
            failures.push(format!("{} [{}]: text={} error={:?} expected={:?} result={:?} expected={:?}\n  actual: {:?}\n  expect: {:?}", case.id, case.classes.join(","), doc.as_str() == case.after, actual_error, case.error, actual_result, case.result, doc.as_str(), case.after));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
