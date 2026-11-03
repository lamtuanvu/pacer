#![allow(clippy::unwrap_used)]

use pacer_plugin::types::{CapabilityHostsRunParams, HostRunnerOpenParams};
use serde_json::json;

#[test]
fn hosts_area_keeps_sdk_type_paths_and_wire_fields() {
    let value = json!({"alias": "box", "sshTarget": "fixture"});
    let params: HostRunnerOpenParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), value);
    let _: Option<CapabilityHostsRunParams> = None;
}
