#![allow(clippy::unwrap_used)]
use pacer_plugin_host::parse_manifest;
use serde_json::json;
#[test]
fn executor_manifest_tuples_accept_exactly_the_typescript_backends() {
    for backend in ["direct", "orca"] {
        let result = parse_manifest(
            json!({"id":"fx-executor","publisher":"test","version":"1.0.0","host":">=1.10.0","contributes":{"executor":{"backends":[backend]}}}),
        );
        assert!(result.is_ok(), "{result:?}");
    }
    for backends in [json!([]), json!(["direct", "orca"]), json!(["unknown"])] {
        assert!(parse_manifest(json!({"id":"fx-executor","publisher":"test","version":"1.0.0","host":">=1.10.0","contributes":{"executor":{"backends":backends}}})).is_err());
    }
}
