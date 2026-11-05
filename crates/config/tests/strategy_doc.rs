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

#[test]
fn loader_keeps_last_duplicate_value_while_the_editor_refuses_duplicate_keys() {
    let text = "key: first\nkey: last\n";
    assert_eq!(
        pacer_config::doc::parse_value(text).unwrap(),
        json!({"key":"last"})
    );
    let error = StrategyDoc::new(text).get_in(&[json!("key")]).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Map keys must be unique at line 2, column 1:\n\nkey: first\nkey: last\n^\n"
    );
}

#[test]
fn yaml_numeric_keys_use_javascript_number_spelling() {
    let value = pacer_config::doc::parse_value("1.0: a\n").unwrap();
    assert_eq!(value["1"], "a");
}

#[test]
fn duplicate_key_diagnostic_on_first_line_matches_yaml_editor() {
    let error = StrategyDoc::new("root: {a: 1, a: 2}\n")
        .get_in(&[json!("root")])
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Map keys must be unique at line 1, column 14:\n\nroot: {a: 1, a: 2}\n             ^\n"
    );
}

#[test]
fn radix_prefixes_require_digits_before_the_loader_resolves_a_number() {
    for text in ["0x+5", "0o+5", "+0x+5", "-0x+5", "0x-5", "0o-5"] {
        let value =
            pacer_config::doc::parse_value(&format!("value: {text}\n{text}: kept\n")).unwrap();
        assert_eq!(value["value"], text);
        assert_eq!(value[text], "kept");
    }
}

#[test]
fn loader_scalar_tags_match_bun_without_changing_editor_resolution() {
    let value = pacer_config::doc::parse_value(
        "a: !!str 1\nb: !!int 1.5\nc: !!int \"1\"\nd: !custom true\ne: !<tag:yaml.org,2002:int> 7\nf: !<tag:yaml.org,2002:bool> true\n",
    )
    .unwrap();
    assert_eq!(
        value,
        json!({"a":"1","b":1.5,"c":"1","d":"true","e":"7","f":"true"})
    );
}

#[test]
fn signed_radix_strings_preserve_their_type_after_bun_stringify() {
    for text in ["+0x5", "+0o5"] {
        let value = json!({"value":text});
        let yaml = pacer_config::doc::stringify_bun(&value);
        assert_eq!(yaml, format!("value: \"{text}\"\n"));
        assert_eq!(pacer_config::doc::parse_value(&yaml).unwrap(), value);
    }
}

#[test]
fn plugin_installed_insert_preserves_disabled_sibling() {
    use pacer_config::doc::StrategyDoc;
    use serde_json::json;
    let before = "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  installed:\n    other:\n      version: 1.0.0\n      capabilities: []\n  disabled:\n    - other\n";
    let mut doc = StrategyDoc::new(before);
    doc.set_in(
        &[json!("plugins"), json!("installed"), json!("fx-ui")],
        &json!({"version":"1.0.0","capabilities":[],"surfaces":["activity"],"policy":true}),
    )
    .unwrap();
    let after = doc.as_str();
    eprintln!("AFTER:\n{after}");
    assert!(after.contains("  disabled:\n"), "{after}");
    assert!(!after.contains("\ndisabled:\n"), "{after}");
}
