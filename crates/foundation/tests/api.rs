#![allow(clippy::unwrap_used)]
use pacer_foundation::Ctx;
use pacer_foundation::api::{Code, CoreError, NativeOp, OpFuture, Registry, params};
use serde_json::{Value, json};

#[test]
fn api_errors_match_shared_typescript_contract() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/core-error-contract.json"
    ))
    .unwrap();
    let mut codes = std::collections::BTreeSet::new();
    for row in rows {
        let code: Code = serde_json::from_value(row["code"].clone()).unwrap();
        codes.insert(row["code"].as_str().unwrap().to_owned());
        let mut error = CoreError::new(code, "contract message");
        if let Some(hint) = row["hint"].as_str() {
            error = error.hint(hint);
        }
        error.data = row["data"].as_object().cloned();
        assert_eq!(error.to_string(), "contract message");
        assert_eq!(error.http_status(), row["status"].as_u64().unwrap() as u16);
        assert_eq!(error.body(), row["body"]);
        assert_eq!(error.rpc(), row["rpc"]);
    }
    assert_eq!(codes.len(), 14);
    assert!(serde_json::from_value::<Code>(json!("made_up")).is_err());
}

#[test]
fn api_params_use_generated_types_and_report_root_errors() {
    use pacer_client_protocol::TaskGetParams;
    for invalid in [json!({}), json!(null), json!([]), json!({"id":42})] {
        let error = params::<TaskGetParams>(invalid).unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert!(error.message.starts_with("params: "));
        assert_eq!(error.http_status(), 400);
        assert_eq!(error.rpc()["code"], -32602);
    }
    assert!(params::<TaskGetParams>(json!({"id":"task-123"})).is_ok());
}

fn echo(_: &Ctx, value: Value) -> OpFuture<'_> {
    Box::pin(async move { Ok(value) })
}
fn ops() -> [NativeOp; 2] {
    [
        NativeOp {
            name: "b",
            call: echo,
        },
        NativeOp {
            name: "a",
            call: echo,
        },
    ]
}

#[test]
fn api_registry_filters_exact_names_and_sorts() {
    let registry = Registry::new(&ops(), "");
    assert_eq!(registry.names(), ["a", "b"]);
    assert!(registry.get("a").is_some());
    assert!(registry.get("unknown").is_none());
    assert_eq!(Registry::new(&ops(), "a").names(), ["b"]);
    assert!(Registry::new(&ops(), "*").names().is_empty());
    assert_eq!(Registry::new(&ops(), " a, missing, a, ").names(), ["b"]);
    assert!(Registry::new(&ops(), "a,*").names().is_empty());
    assert_eq!(Registry::new(&ops(), "A").names(), ["a", "b"]);
    assert!(Registry::new(&[], "").names().is_empty());
}
