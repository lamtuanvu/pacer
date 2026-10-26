#![allow(clippy::unwrap_used)]

use serde_json::Value;

fn goldens() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/strategy-load/goldens.json"
    ))
    .unwrap()
}

#[test]
fn all_valid_oracle_strategies_normalize_like_typescript() {
    let selected = [
        "current-basic",
        "current-pacing",
        "current-host",
        "current-execution",
        "current-host-advanced",
        "legacy-basic",
        "legacy-reversed",
        "legacy-opencode",
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

#[test]
fn unsupported_execution_and_host_limits_stay_with_typescript() {
    let base =
        "planner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
    for field in [
        "execution: {local_max_tasks: 0}\n",
        "execution: {local_max_tasks: 17}\n",
        "execution: {local_max_tasks: 2.5}\n",
        "execution: {other: true}\n",
        "hosts: {devbox: {ssh: dev-ssh, max_tasks: 0}}\n",
        "hosts: {devbox: {ssh: dev-ssh, max_tasks: 17}}\n",
        "hosts: {devbox: {ssh: dev-ssh, max_tasks: 2.5}}\n",
    ] {
        assert_eq!(
            pacer_config::strategy_load::normalize_basic(&format!("{base}{field}"), "default"),
            None,
            "{field}"
        );
    }
}
