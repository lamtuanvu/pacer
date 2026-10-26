#![allow(clippy::unwrap_used)]
use pacer_plugin_policy_protocol::{
    CapabilityEventsSubscribeParams, CapabilityTasksListParams, PolicyBeforeParams,
    PolicyBeforeResult,
};
use serde_json::json;
#[test]
fn policy_decisions_and_observation_bounds_match_the_wire_contract() {
    let input = json!({"decision":"delegate","input":{"goal":"g","repo":"/tmp/r","kind":null,"requestedExecutor":null,"placement":"auto"}});
    let value: PolicyBeforeParams = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(value).unwrap(), input);
    assert!(
        serde_json::from_value::<PolicyBeforeResult>(
            json!({"verdict":"amend","amend":{"goal":"replace"}})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<CapabilityTasksListParams>(json!({"limit":501})).is_err());
    assert!(
        serde_json::from_value::<CapabilityEventsSubscribeParams>(json!({"types":["budget"]}))
            .is_err()
    );
}

#[test]
fn integer_deserialization_enforces_declared_bounds_and_safe_integer_domain() {
    use pacer_plugin_policy_protocol::PolicyEvent;
    for limit in [1, 500] {
        assert!(
            serde_json::from_value::<CapabilityTasksListParams>(json!({"limit":limit})).is_ok()
        );
    }
    assert!(serde_json::from_value::<CapabilityTasksListParams>(json!({})).is_ok());
    for limit in [
        json!(0),
        json!(501),
        json!(-1),
        json!(u64::MAX),
        json!(1.5),
        json!(null),
    ] {
        assert!(
            serde_json::from_value::<CapabilityTasksListParams>(json!({"limit":limit})).is_err()
        );
    }
    for revision in [json!(0), json!(9_007_199_254_740_991u64)] {
        assert!(serde_json::from_value::<PolicyBeforeParams>(json!({"decision":"review","input":{"taskId":"t","revision":revision,"state":"done","verdict":"accept"}})).is_ok());
    }
    for revision in [
        json!(-1),
        json!(9_007_199_254_740_992u64),
        json!(u64::MAX),
        json!(1.25),
    ] {
        assert!(serde_json::from_value::<PolicyBeforeParams>(json!({"decision":"review","input":{"taskId":"t","revision":revision,"state":"done","verdict":"accept"}})).is_err());
    }
    for seq in [json!(0), json!(9_007_199_254_740_991u64)] {
        assert!(
            serde_json::from_value::<PolicyEvent>(
                json!({"seq":seq,"at":0,"type":"task","data":{}})
            )
            .is_ok()
        );
    }
    for seq in [
        json!(-1),
        json!(9_007_199_254_740_992u64),
        json!(u64::MAX),
        json!(2.5),
    ] {
        assert!(
            serde_json::from_value::<PolicyEvent>(
                json!({"seq":seq,"at":0,"type":"task","data":{}})
            )
            .is_err()
        );
    }
}

#[test]
fn metadata_domains_are_presence_exclusive_without_rejecting_future_fields() {
    use pacer_plugin_policy_protocol::{PluginMetadata, ReadOwnerMetadata};
    for value in [
        json!({"capabilityCall":"call","future":true}),
        json!({"readOwner":"owner","future":true}),
    ] {
        let parsed: PluginMetadata = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
    let read: ReadOwnerMetadata =
        serde_json::from_value(json!({"readOwner":"owner","future":true})).unwrap();
    assert_eq!(
        serde_json::to_value(read).unwrap(),
        json!({"readOwner":"owner","future":true})
    );
    for token in [json!(""), json!(null), json!(3), json!("x".repeat(257))] {
        assert!(serde_json::from_value::<PluginMetadata>(json!({"capabilityCall":token})).is_err());
        assert!(serde_json::from_value::<PluginMetadata>(json!({"readOwner":token})).is_err());
        assert!(
            serde_json::from_value::<ReadOwnerMetadata>(
                json!({"readOwner":"owner","capabilityCall":token})
            )
            .is_err()
        );
    }
    for opposite in [json!("owner"), json!(""), json!(3), json!(null), json!({})] {
        assert!(
            serde_json::from_value::<PluginMetadata>(
                json!({"capabilityCall":"call","readOwner":opposite})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<PluginMetadata>(
                json!({"capabilityCall":opposite,"readOwner":"owner"})
            )
            .is_err()
        );
    }
    for value in [
        json!({}),
        json!({"capabilityCall":""}),
        json!({"readOwner":null}),
        json!({"readOwner":"x".repeat(257)}),
    ] {
        assert!(serde_json::from_value::<PluginMetadata>(value).is_err());
    }
}

#[test]
fn subscription_task_result_and_state_collections_keep_schema_bounds() {
    use pacer_plugin_policy_protocol::CapabilityTasksListResult;
    for length in [1, 32] {
        assert!(
            serde_json::from_value::<CapabilityEventsSubscribeParams>(
                json!({"types":vec!["task";length]})
            )
            .is_ok()
        );
    }
    for length in [0, 33] {
        assert!(
            serde_json::from_value::<CapabilityEventsSubscribeParams>(
                json!({"types":vec!["task";length]})
            )
            .is_err()
        );
    }
    for length in [0, 500] {
        assert!(
            serde_json::from_value::<CapabilityTasksListResult>(
                json!({"tasks":vec![json!({"id":"t","state":"done"});length]})
            )
            .is_ok()
        );
    }
    assert!(
        serde_json::from_value::<CapabilityTasksListResult>(
            json!({"tasks":vec![json!({"id":"t","state":"done"});501]})
        )
        .is_err()
    );
    for length in [0, 8] {
        assert!(
            serde_json::from_value::<CapabilityTasksListParams>(
                json!({"states":vec!["running";length]})
            )
            .is_ok()
        );
    }
    assert!(
        serde_json::from_value::<CapabilityTasksListParams>(json!({"states":vec!["running";9]}))
            .is_err()
    );
}
