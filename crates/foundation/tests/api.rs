use pacer_client_protocol::TaskGetParams;
use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::{NativeOp, OpFuture, Registry, params},
    },
};
use serde_json::{Map, Value, json};

#[test]
fn every_error_code_matches_the_frozen_client_boundary() {
    for (code, name, http, rpc) in [
        (Code::UnknownOp, "unknown_op", 404, -32601),
        (Code::UnknownTask, "unknown_task", 404, -32000),
        (Code::InvalidInput, "invalid_input", 400, -32602),
        (Code::UnknownExecutor, "unknown_executor", 404, -32000),
        (Code::Conflict, "conflict", 409, -32000),
        (Code::NotAllowed, "not_allowed", 403, -32000),
        (Code::NotFound, "not_found", 404, -32000),
        (Code::TooLarge, "too_large", 413, -32000),
        (Code::Internal, "internal", 500, -32000),
        (Code::PluginTimeout, "plugin_timeout", 504, -32000),
        (Code::PluginUnavailable, "plugin_unavailable", 503, -32000),
        (Code::PluginRefused, "plugin_refused", 422, -32000),
        (Code::CapabilityDenied, "capability_denied", 403, -32000),
        (Code::UnknownPlugin, "unknown_plugin", 404, -32000),
    ] {
        let mut error = CoreError::new(code, "failure").hint("retry");
        error.data = Some(Box::new(Map::from_iter([("private".into(), json!(true))])));
        let serialized = match serde_json::to_value(code) {
            Ok(value) => value,
            Err(error) => panic!("code serialization failed: {error}"),
        };
        assert_eq!(serialized, json!(name));
        assert_eq!(error.http_status(), http);
        assert_eq!(
            error.body(),
            json!({"error":{"code":name,"message":"failure","hint":"retry","data":{"private":true}}})
        );
        assert_eq!(
            error.rpc(),
            json!({"code":rpc,"message":"failure","data":{"code":name,"hint":"retry"}})
        );
    }
    let error = CoreError::new(Code::Conflict, "stale").hint("");
    assert_eq!(
        error.body(),
        json!({"error":{"code":"conflict","message":"stale"}})
    );
    assert_eq!(
        error.rpc(),
        json!({"code":-32000,"message":"stale","data":{"code":"conflict"}})
    );
}

fn echo<'a>(_: &'a Ctx, input: Value) -> OpFuture<'a> {
    Box::pin(async move { Ok(input) })
}

static OPS: [NativeOp; 2] = [
    NativeOp {
        name: "test.echo",
        call: echo,
    },
    NativeOp {
        name: "test.other",
        call: echo,
    },
];

#[test]
fn registry_excludes_forced_forward_operations() {
    let registry = Registry::new(&OPS, "test.echo");
    assert!(registry.get("test.echo").is_none());
    assert!(registry.get("test.other").is_some());
    assert_eq!(registry.names(), vec!["test.other"]);
    assert!(Registry::new(&OPS, "*").names().is_empty());
    assert_eq!(
        Registry::new(&OPS, "test.unknown").names(),
        vec!["test.echo", "test.other"]
    );
}

#[test]
fn invalid_generated_parameters_keep_the_api_code() {
    let error = match params::<TaskGetParams>(json!({})) {
        Ok(_) => panic!("missing task id was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.code, Code::InvalidInput);
    assert!(error.message.starts_with("params: "));
}
