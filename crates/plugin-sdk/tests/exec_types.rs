#![allow(clippy::unwrap_used)]

use pacer_plugin::types::{
    CapabilityProcessDuplexCloseParams, CapabilityProcessSpawnParams, ExecutorAvailableParams,
    ExecutorSessionStateResult,
};
use serde_json::json;

#[test]
fn exec_area_keeps_sdk_type_paths_and_wire_fields() {
    let value = json!({"strategy": {"name": "fixture"}});
    let params: ExecutorAvailableParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), value);
    let _: Option<CapabilityProcessSpawnParams> = None;
    let _: Option<CapabilityProcessDuplexCloseParams> = None;
    for state in ["running", "exited", "uncertain"] {
        let value = json!({"state": state, "host": "builtin", "handle": null});
        let receipt: ExecutorSessionStateResult = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(receipt).unwrap(), value);
    }
}
