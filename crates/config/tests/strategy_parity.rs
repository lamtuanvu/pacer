#![allow(clippy::unwrap_used)]

use pacer_config::strategy::{StrategyError, validate_strategy};
use serde_json::Value;
use std::path::Path;

#[test]
fn normalized_strategies_and_errors_match_typescript_goldens() {
    for case in [
        include_str!("../../../test/fixtures/strategy-read/cases.json"),
        include_str!("../../../test/fixtures/strategy-read/refinements.json"),
        include_str!("../../../test/fixtures/strategy-read/boundaries.json"),
    ]
    .into_iter()
    .flat_map(|fixture| {
        serde_json::from_str::<Value>(fixture)
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }) {
        let name = case["name"].as_str().unwrap();
        let result = validate_strategy(&case["raw"], Path::new("strategy.yaml"), name);
        if let Some(expected) = case.get("expected") {
            assert_eq!(result.unwrap(), *expected, "case {name}");
        } else {
            let Err(StrategyError::Invalid { problems, .. }) = result else {
                panic!("case {name}: expected validation error")
            };
            assert_eq!(Value::from(problems), case["problems"], "case {name}");
        }
    }
}

#[test]
fn migrated_yaml_matches_typescript_bytes() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-read/migrations.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("strategy.yaml");
        std::fs::write(&path, case["before"].as_str().unwrap()).unwrap();
        pacer_config::strategy::migrate_strategy(&path, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            case["after"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn isolated_named_reads_match_typescript_results_and_yaml() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-read/named.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (relative, text) in fixture["files"].as_object().unwrap() {
        let path = dir.path().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text.as_str().unwrap()).unwrap();
    }
    std::fs::write(
        dir.path().join("active"),
        fixture["active"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(
        pacer_config::strategy::list_strategy_reads(dir.path()).unwrap(),
        fixture["expected"]["list"]
    );
    assert_eq!(
        pacer_config::strategy::show_strategy(dir.path(), "work").unwrap(),
        fixture["expected"]["show"]
    );
    assert_eq!(
        pacer_config::strategy::load_strategy(dir.path()).unwrap(),
        fixture["expected"]["load"]
    );
}
