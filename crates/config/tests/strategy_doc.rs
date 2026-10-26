#![allow(clippy::unwrap_used)]

use serde_json::Value;

fn goldens() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-doc/goldens.json"
    ))
    .unwrap()
}

#[test]
fn existing_scalar_edits_match_typescript_bytes() {
    let supported = [
        "scalar-plain",
        "scalar-ambiguous",
        "scalar-colon",
        "scalar-hash",
        "scalar-unicode",
        "quote-single",
        "quote-double",
        "scalar-inline-comment",
        "scalar-boolean",
        "scalar-null",
        "scalar-float",
        "set-index",
        "crlf-scalar",
    ];
    let cases = goldens();
    for id in supported {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        let path = case["path"].as_array().unwrap();
        assert_eq!(
            pacer_config::doc::replace_existing_scalar(
                case["before"].as_str().unwrap(),
                path,
                &case["value"],
            ),
            Some(case["after"].as_str().unwrap().to_owned()),
            "{id}"
        );
    }
}

#[test]
fn unsupported_edit_classes_do_not_produce_rewrites() {
    let unsupported = [
        "scalar-multiline",
        "flow-insert",
        "list-flow-append",
        "replace-routing-append",
    ];
    let cases = goldens();
    for id in unsupported {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        let path = case["path"].as_array().unwrap();
        assert_eq!(
            pacer_config::doc::replace_existing_scalar(
                case["before"].as_str().unwrap(),
                path,
                &case["value"],
            ),
            None,
            "{id}"
        );
    }
}

#[test]
fn unicode_before_target_uses_character_spans_without_corrupting_bytes() {
    let before = "# λ strategy\nplanner: codex # keep\n";
    let after = "# λ strategy\nplanner: local # keep\n";
    assert_eq!(
        pacer_config::doc::replace_existing_scalar(
            before,
            &[Value::from("planner")],
            &Value::from("local")
        ),
        Some(after.to_owned())
    );
}

#[test]
fn unsafe_javascript_integer_range_is_not_emitted() {
    let before = "pacing: {planner_reserve: 15}\n";
    assert_eq!(
        pacer_config::doc::replace_existing_scalar(
            before,
            &[Value::from("pacing"), Value::from("planner_reserve")],
            &Value::from(9_007_199_254_740_992_u64),
        ),
        None
    );
}

#[test]
fn quoted_style_is_kept_but_complex_source_escapes_forward() {
    let path = &[Value::from("planner")];
    assert_eq!(
        pacer_config::doc::replace_existing_scalar(
            "planner: 'codex' # keep\n",
            path,
            &Value::from("local")
        ),
        Some("planner: 'local' # keep\n".to_owned())
    );
    assert_eq!(
        pacer_config::doc::replace_existing_scalar(
            "planner: 'a''b' # keep\n",
            path,
            &Value::from("local")
        ),
        None
    );
    assert_eq!(
        pacer_config::doc::replace_existing_scalar(
            "planner: \"a\\\"b\" # keep\n",
            path,
            &Value::from("local")
        ),
        None
    );
}

#[test]
fn inserting_simple_flow_map_scalars_matches_typescript_bytes() {
    let cases = goldens();
    for id in ["flow-insert", "empty-flow-insert"] {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        assert_eq!(
            pacer_config::doc::insert_missing_flow_scalar(
                case["before"].as_str().unwrap(),
                case["path"].as_array().unwrap(),
                &case["value"],
            ),
            Some(case["after"].as_str().unwrap().to_owned()),
            "{id}"
        );
    }
    let block = cases
        .iter()
        .find(|case| case["id"] == "block-insert")
        .unwrap();
    assert_eq!(
        pacer_config::doc::insert_missing_flow_scalar(
            block["before"].as_str().unwrap(),
            block["path"].as_array().unwrap(),
            &block["value"],
        ),
        None
    );
    assert_eq!(
        pacer_config::doc::insert_missing_flow_scalar(
            "pacing: { } # keep\n",
            &[Value::from("pacing"), Value::from("policy")],
            &Value::from("priority"),
        ),
        None
    );
    assert_eq!(
        pacer_config::doc::insert_missing_flow_scalar(
            "pacing: {policy: priority } # keep\n",
            &[Value::from("pacing"), Value::from("fill_threshold")],
            &Value::from(95),
        ),
        None
    );
}

#[test]
fn every_selected_flow_insertion_in_the_corpus_matches_typescript_after_bytes() {
    let mut selected = Vec::new();
    for case in goldens() {
        if !matches!(case["op"].as_str(), Some("setIn" | "setScalar")) {
            continue;
        }
        let Some(path) = case["path"].as_array() else {
            continue;
        };
        let Some(before) = case["before"].as_str() else {
            continue;
        };
        let Some(after) = case["after"].as_str() else {
            continue;
        };
        if let Some(output) =
            pacer_config::doc::insert_missing_flow_scalar(before, path, &case["value"])
        {
            assert_eq!(output, after, "{}", case["id"]);
            selected.push(case["id"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(selected, ["flow-insert", "empty-flow-insert"]);
}

#[test]
fn every_selected_edit_in_the_corpus_matches_its_typescript_after_bytes() {
    let mut selected = Vec::new();
    for case in goldens() {
        if !matches!(case["op"].as_str(), Some("setIn" | "setScalar")) {
            continue;
        }
        let Some(path) = case["path"].as_array() else {
            continue;
        };
        let Some(before) = case["before"].as_str() else {
            continue;
        };
        let Some(after) = case["after"].as_str() else {
            continue;
        };
        if let Some(output) =
            pacer_config::doc::replace_existing_scalar(before, path, &case["value"])
        {
            assert_eq!(output, after, "{}", case["id"]);
            selected.push(case["id"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(
        selected,
        [
            "scalar-inline-comment",
            "scalar-plain",
            "scalar-ambiguous",
            "scalar-colon",
            "scalar-hash",
            "scalar-unicode",
            "quote-single",
            "quote-double",
            "scalar-boolean",
            "scalar-null",
            "scalar-float",
            "set-index",
            "crlf-scalar"
        ]
    );
}
