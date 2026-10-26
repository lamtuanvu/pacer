#![allow(clippy::unwrap_used)]

use serde_json::Value;

fn goldens() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-doc/goldens.json"
    ))
    .unwrap()
}

#[test]
fn existing_plain_scalar_edits_match_typescript_bytes() {
    let supported = [
        "scalar-plain",
        "scalar-inline-comment",
        "scalar-boolean",
        "scalar-null",
        "set-index",
        "crlf-scalar",
    ];
    let cases = goldens();
    for id in supported {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        let path = case["path"].as_array().unwrap();
        assert_eq!(
            pacer_config::doc::replace_existing_plain_scalar(
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
        "scalar-ambiguous",
        "scalar-multiline",
        "quote-single",
        "quote-double",
        "flow-insert",
        "list-flow-append",
        "replace-routing-append",
    ];
    let cases = goldens();
    for id in unsupported {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        let path = case["path"].as_array().unwrap();
        assert_eq!(
            pacer_config::doc::replace_existing_plain_scalar(
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
        pacer_config::doc::replace_existing_plain_scalar(
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
        pacer_config::doc::replace_existing_plain_scalar(
            before,
            &[Value::from("pacing"), Value::from("planner_reserve")],
            &Value::from(9_007_199_254_740_992_u64),
        ),
        None
    );
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
            pacer_config::doc::replace_existing_plain_scalar(before, path, &case["value"])
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
            "scalar-boolean",
            "scalar-null",
            "set-index",
            "crlf-scalar"
        ]
    );
}
