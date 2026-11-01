#![allow(clippy::unwrap_used)]

use pacer_foundation::Ctx;
use pacer_foundation::api::{Code, CoreError, NativeOp, OpFuture, Registry, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[test]
fn api_error_codes_match_the_typescript_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/api-error-contract.json"
    ))
    .unwrap();
    let codes = [
        ("unknown_op", Code::UnknownOp),
        ("unknown_task", Code::UnknownTask),
        ("invalid_input", Code::InvalidInput),
        ("unknown_executor", Code::UnknownExecutor),
        ("conflict", Code::Conflict),
        ("not_allowed", Code::NotAllowed),
        ("not_found", Code::NotFound),
        ("too_large", Code::TooLarge),
        ("internal", Code::Internal),
        ("unavailable", Code::Unavailable),
        ("rate_limited", Code::RateLimited),
        ("plugin_timeout", Code::PluginTimeout),
        ("plugin_unavailable", Code::PluginUnavailable),
        ("plugin_refused", Code::PluginRefused),
        ("capability_denied", Code::CapabilityDenied),
        ("unknown_plugin", Code::UnknownPlugin),
    ];
    assert_eq!(fixture["codes"].as_array().unwrap().len(), codes.len());
    for (name, code) in codes {
        let row = fixture["codes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["code"] == name)
            .unwrap();
        let error = CoreError::new(code, format!("sample {name}"));
        assert_eq!(
            error.http_status(),
            row["http"].as_u64().unwrap() as u16,
            "{name}"
        );
        assert_eq!(error.rpc()["code"], row["rpc"], "{name}");
        assert_eq!(error.body()["error"]["code"], name, "{name}");
    }
    let empty = CoreError::new(Code::Conflict, "sample conflict")
        .hint("")
        .data(serde_json::Map::new());
    let full = CoreError::new(Code::Conflict, "sample conflict")
        .hint("retry")
        .data(json!({"expected": 1}).as_object().unwrap().clone());
    assert_eq!(empty.body(), fixture["samples"][0]["body"]);
    assert_eq!(empty.rpc(), fixture["samples"][0]["rpc"]);
    assert_eq!(full.body(), fixture["samples"][1]["body"]);
    assert_eq!(full.rpc(), fixture["samples"][1]["rpc"]);
}

#[derive(Deserialize)]
struct RequiredParams {
    #[allow(dead_code)]
    id: String,
}

#[test]
fn api_params_errors_are_invalid_input() {
    let error = params::<RequiredParams>(json!({})).err().unwrap();
    assert_eq!(error.code, Code::InvalidInput);
    assert!(error.message.starts_with("params: "));
}

fn noop(_ctx: &Ctx, _value: Value) -> OpFuture<'_> {
    Box::pin(async { Ok(Value::Null) })
}

#[test]
fn api_registry_forward_only_removes_native_handlers() {
    let ops = [
        NativeOp {
            name: "b",
            call: noop,
        },
        NativeOp {
            name: "a",
            call: noop,
        },
    ];
    assert_eq!(Registry::new(&ops, "").names(), vec!["a", "b"]);
    assert_eq!(Registry::new(&ops, " a ").names(), vec!["b"]);
    assert!(Registry::new(&ops, "*").names().is_empty());
    assert!(Registry::new(&ops, "a").get("a").is_none());
}

#[test]
fn api_unknown_op_uses_sorted_union_of_native_and_forwarded_names() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/api-error-contract.json"
    ))
    .unwrap();
    let names: Vec<&str> = fixture["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect();
    assert!(names.contains(&"api.list"));
    assert!(names.contains(&"task.get"));
    assert!(names.contains(&"task.list"));
    let ops = [
        NativeOp {
            name: "task.get",
            call: noop,
        },
        NativeOp {
            name: "api.list",
            call: noop,
        },
    ];
    let registry = Registry::new(&ops, "task.get");
    assert_eq!(registry.names(), vec!["api.list"]);
    let forwarded: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| !["api.list", "task.get"].contains(name))
        .collect();
    assert!(forwarded.contains(&"task.list"));
    let error = registry.unknown_op("missing.operation", &forwarded);
    assert_eq!(error.message, "unknown operation \"missing.operation\"");
    assert_eq!(
        error.hint.as_deref(),
        Some(format!("operations: {}", names.join(", ")).as_str())
    );
}
