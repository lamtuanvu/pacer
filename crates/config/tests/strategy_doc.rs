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
fn flow_map_deletion_matches_first_middle_last_only_and_crlf_goldens() {
    let cases = goldens();
    for id in [
        "flow-delete-first",
        "flow-delete-middle",
        "flow-delete-last",
        "flow-delete-only",
        "crlf-delete",
        "delete-absent",
    ] {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        assert_eq!(
            pacer_config::doc::delete_flow_entry(
                case["before"].as_str().unwrap(),
                case["path"].as_array().unwrap()
            ),
            Some(case["after"].as_str().unwrap().to_owned()),
            "{id}"
        );
    }
    let block = cases
        .iter()
        .find(|case| case["id"] == "delete-null")
        .unwrap();
    assert_eq!(
        pacer_config::doc::delete_flow_entry(
            block["before"].as_str().unwrap(),
            block["path"].as_array().unwrap()
        ),
        None
    );
}

#[test]
fn simple_mapping_key_rename_matches_typescript_goldens() {
    let cases = goldens();
    for id in ["rename-routing-key", "rename-quoted-key"] {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        assert_eq!(
            pacer_config::doc::rename_mapping_key(
                case["before"].as_str().unwrap(),
                case["path"].as_array().unwrap(),
                case["value"].as_str().unwrap(),
            ),
            Some(case["after"].as_str().unwrap().to_owned()),
            "{id}"
        );
    }
    for id in ["rename-conflict", "rename-missing"] {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        assert_eq!(
            pacer_config::doc::rename_mapping_key(
                case["before"].as_str().unwrap(),
                case["path"].as_array().unwrap(),
                case["value"].as_str().unwrap(),
            ),
            None,
            "{id}"
        );
    }
}

#[test]
fn every_selected_map_edit_in_the_corpus_matches_typescript_after_bytes() {
    let mut selected = Vec::new();
    for case in goldens() {
        let Some(before) = case["before"].as_str() else {
            continue;
        };
        let Some(path) = case["path"].as_array() else {
            continue;
        };
        let output = match case["op"].as_str() {
            Some("deleteIn") => pacer_config::doc::delete_flow_entry(before, path),
            Some("renameKey") => case["value"]
                .as_str()
                .and_then(|name| pacer_config::doc::rename_mapping_key(before, path, name)),
            _ => continue,
        };
        if let Some(output) = output {
            assert_eq!(output, case["after"].as_str().unwrap(), "{}", case["id"]);
            selected.push(case["id"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(
        selected,
        [
            "flow-delete-first",
            "flow-delete-middle",
            "flow-delete-last",
            "delete-absent",
            "rename-routing-key",
            "rename-quoted-key",
            "crlf-delete",
            "flow-delete-only",
        ]
    );
}

#[test]
fn unsupported_map_layouts_and_key_names_stay_with_typescript() {
    use serde_json::json;

    assert_eq!(
        pacer_config::doc::delete_flow_entry(
            "pacing: { policy: priority}\n",
            &[json!("pacing"), json!("policy")]
        ),
        None
    );
    assert_eq!(
        pacer_config::doc::delete_flow_entry(
            "pacing: {policy: [first, second]}\n",
            &[json!("pacing"), json!("policy")]
        ),
        None
    );
    assert_eq!(
        pacer_config::doc::rename_mapping_key(
            "pacing: {policy: priority}\n",
            &[json!("pacing"), json!("policy")],
            "new\nkey"
        ),
        None
    );
}

#[test]
fn strict_flow_list_rewrites_match_typescript_bytes() {
    let cases = goldens();
    for id in [
        "list-flow-append",
        "list-flow-padding",
        "list-duplicate-reorder",
        "list-empty",
        "crlf-list",
    ] {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        assert_eq!(
            pacer_config::doc::replace_flow_list(
                case["before"].as_str().unwrap(),
                case["path"].as_array().unwrap(),
                case["value"].as_array().unwrap(),
            ),
            Some(case["after"].as_str().unwrap().to_owned()),
            "{id}"
        );
    }
    let block = cases
        .iter()
        .find(|case| case["id"] == "list-block-survivor-comment")
        .unwrap();
    assert_eq!(
        pacer_config::doc::replace_flow_list(
            block["before"].as_str().unwrap(),
            block["path"].as_array().unwrap(),
            block["value"].as_array().unwrap(),
        ),
        None
    );
}

#[test]
fn every_selected_flow_list_in_the_corpus_matches_typescript_after_bytes() {
    let mut selected = Vec::new();
    for case in goldens() {
        if case["op"] != "setList" {
            continue;
        }
        let (Some(before), Some(path), Some(values)) = (
            case["before"].as_str(),
            case["path"].as_array(),
            case["value"].as_array(),
        ) else {
            continue;
        };
        if let Some(output) = pacer_config::doc::replace_flow_list(before, path, values) {
            assert_eq!(output, case["after"].as_str().unwrap(), "{}", case["id"]);
            selected.push(case["id"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(
        selected,
        [
            "list-flow-append",
            "list-flow-padding",
            "list-duplicate-reorder",
            "list-empty",
            "crlf-list"
        ]
    );
}

#[test]
fn unproven_flow_list_styles_stay_with_typescript() {
    use serde_json::json;

    let path = [json!("routing")];
    assert_eq!(
        pacer_config::doc::replace_flow_list("routing: []\n", &path, &[json!("codex")]),
        None
    );
    assert_eq!(
        pacer_config::doc::replace_flow_list("routing: [ codex ]\n", &path, &[]),
        None
    );
    assert_eq!(
        pacer_config::doc::replace_flow_list("routing: ['codex']\n", &path, &[json!("local")]),
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
