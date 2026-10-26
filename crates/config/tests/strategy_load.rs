#![allow(clippy::unwrap_used)]

use serde_json::Value;

fn goldens() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-load/goldens.json"
    ))
    .unwrap()
}

#[test]
fn basic_current_strategy_normalization_matches_typescript() {
    let selected = [
        "current-basic",
        "current-pacing",
        "active-name",
        "flow-and-comments",
        "crlf",
    ];
    for case in goldens() {
        let actual = pacer_config::strategy_load::normalize_basic(
            case["yaml"].as_str().unwrap(),
            case["name"].as_str().unwrap_or("default"),
        );
        if selected.contains(&case["id"].as_str().unwrap()) {
            assert_eq!(actual, Some(case["result"].clone()), "{}", case["id"]);
        } else {
            assert_eq!(actual, None, "{}", case["id"]);
        }
    }
}
