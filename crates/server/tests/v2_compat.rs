#![allow(clippy::unwrap_used)] // Golden fixture assertions are test-only.
use pacer_server::v2_compat::{event, op_result, params};
use serde_json::Value;

#[test]
fn shared_conversion_goldens() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/protocol-v2/conversions.json"
    ))
    .unwrap();
    for row in data["params"].as_array().unwrap() {
        assert_eq!(
            params(row["name"].as_str().unwrap(), &row["input"]).unwrap(),
            row["output"],
            "{row}"
        );
    }
    for row in data["results"].as_array().unwrap() {
        assert_eq!(
            op_result(row["name"].as_str().unwrap(), &row["input"]),
            row["output"],
            "{row}"
        );
    }
    for row in data["events"].as_array().unwrap() {
        assert_eq!(event(&row["input"], None), row["output"], "{row}");
    }
}

#[test]
fn complete_characterization() {
    use pacer_server::v2_compat as v2;
    let data: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/protocol-v2/characterization.json"
    ))
    .unwrap();
    for kind in [
        "params",
        "results",
        "events",
        "snapshots",
        "discovery",
        "setup",
    ] {
        for row in data[kind].as_array().unwrap() {
            let input = &row["input"];
            let output = match kind {
                "params" => match v2::params(row["name"].as_str().unwrap(), input) {
                    Ok(value) => serde_json::json!({"value":value}),
                    Err(message) => {
                        serde_json::json!({"error":{"code":"invalid_input","message":message}})
                    }
                },
                "results" => v2::op_result_with_legacy(
                    row["name"].as_str().unwrap(),
                    input,
                    row.get("legacy"),
                ),
                "events" => v2::event(input, row.get("legacy")),
                "snapshots" => v2::snapshot(input, row.get("legacy")),
                "setup" => v2::setup(input, false),
                "discovery" => {
                    serde_json::json!({"id":v2::is_discovery_item_id(&input["data"]["id"]),"only":v2::v3_only_event(input)})
                }
                _ => unreachable!(),
            };
            assert_eq!(
                output,
                row["output"],
                "{kind}: {}",
                row.get("id").unwrap_or(row)
            );
        }
    }
    assert_eq!(v2::hello(&data["hello"]["input"]), data["hello"]["output"]);
    assert_eq!(
        v2::op_schemas(&data["schemas"]["input"]).to_string(),
        data["schemas"]["output"].to_string()
    );
    assert_eq!(serde_json::json!(v2::V3_ONLY_OPS), data["v3OnlyOps"]);
}

#[test]
fn operation_boundary_keeps_v3_private_and_maps_errors() {
    use pacer_server::v2_compat as v2;
    use serde_json::json;
    for name in v2::V3_ONLY_OPS {
        assert_eq!(
            v2::call_params(name, &json!({})).unwrap_err().body(),
            json!({"error":{"code":"unknown_op","message":format!("unknown operation \"{name}\""),"hint":format!("{name} requires protocol 3")}})
        );
    }
    assert_eq!(
        v2::call_params("task.review", &json!({"accepted":null}))
            .unwrap_err()
            .body(),
        json!({"error":{"code":"invalid_input","message":"accepted: expected boolean"}})
    );
    assert_eq!(
        v2::call_params(
            "config.set",
            &json!({"key":"update_channel","value":"nightly"})
        )
        .unwrap_err()
        .body(),
        json!({"error":{"code":"invalid_input","message":"key: \"update_channel\" requires protocol 3"}})
    );
    assert_eq!(
        v2::op_schemas(
            &json!({"config.set":{"params":{"properties":{"key":{"enum":["update_check","update_channel","pacing.planner_tier_fallback","terminal.app"]}}}}})
        )["config.set"]["params"]["properties"]["key"]["enum"],
        json!(["update_check", "terminal.app"])
    );
    assert_eq!(
        v2::call_params(
            "config.set",
            &json!({"key":"pacing.planner_tier_fallback","value":"off"})
        )
        .unwrap_err()
        .body(),
        json!({"error":{"code":"invalid_input","message":"key: \"pacing.planner_tier_fallback\" requires protocol 3"}})
    );
    assert_eq!(
        v2::call_params(
            "routing.route",
            &json!({"kind":"feature","difficulty":"complex"})
        )
        .unwrap_err()
        .body(),
        json!({"error":{"code":"invalid_input","message":"params: Unrecognized key: \"difficulty\""}})
    );
    assert!(
        v2::op_schemas(
            &json!({"routing.route":{"params":{"properties":{"kind":{},"difficulty":{}}}}})
        )["routing.route"]["params"]["properties"]
            .get("difficulty")
            .is_none()
    );
    assert_eq!(
        v2::call_params("client.register", &json!(["a"])).unwrap(),
        json!({"0":"a"})
    );
    assert_eq!(
        v2::call_params("task.review", &json!({"accepted":true})).unwrap(),
        json!({"verdict":"accept"})
    );
}
