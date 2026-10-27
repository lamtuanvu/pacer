#![allow(clippy::unwrap_used)]

use pacer_plugin::types::{
    CapabilityProcessClaimRunParams, CapabilityProcessCompleteReportedRunParams,
    CapabilityProcessDuplexCloseParams, CapabilityProcessPollRunResult,
    CapabilityProcessReadRunOutputParams, CapabilityProcessSpawnParams, ExecutorAvailableParams,
    ExecutorRunOwnedResultReport, ExecutorRunParams, ExecutorRunParamsEffect,
    ExecutorRunParamsTask, ExecutorRunResultVariant0Report, ExecutorRunResultVariant0Status,
    ExecutorRunResultVariant1Report, ExecutorSessionStateResult,
};
use serde_json::json;

#[test]
fn exec_area_keeps_sdk_type_paths_and_wire_fields() {
    let value = json!({"strategy": {"name": "fixture"}});
    let params: ExecutorAvailableParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), value);
    let _: Option<CapabilityProcessSpawnParams> = None;
    let _: Option<CapabilityProcessClaimRunParams> = None;
    let _: Option<CapabilityProcessCompleteReportedRunParams> = None;
    let _: Option<CapabilityProcessPollRunResult> = None;
    let _: Option<CapabilityProcessReadRunOutputParams> = None;
    let _: Option<CapabilityProcessDuplexCloseParams> = None;
    let _: Option<ExecutorRunParamsEffect> = None;
    let _: Option<ExecutorRunParamsTask> = None;
    let _: Option<ExecutorRunResultVariant0Report> = None;
    let _: Option<ExecutorRunResultVariant0Status> = None;
    let _: Option<ExecutorRunResultVariant1Report> = None;
    let _: Option<ExecutorRunOwnedResultReport> = None;
    let owned = json!({"task":{"id":"t-20261027-102417-e2b4","rev":1},"attempt":1,
        "runDir":1.0,"owned":{"placement":"current","timeoutMs":1000,
        "executor":"codex","model":null}});
    let params: ExecutorRunParams = serde_json::from_value(owned.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), owned);
    for state in ["running", "exited", "uncertain"] {
        let value = json!({"state": state, "host": "builtin", "handle": null});
        let receipt: ExecutorSessionStateResult = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(receipt).unwrap(), value);
    }
}
