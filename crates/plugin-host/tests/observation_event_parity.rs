//! Pins the Rust plugin host's observation event list to the generated
//! plugin-policy-protocol contract. The host's `POLICY_EVENT_TYPES` is the set
//! of v3 events plugins may subscribe to; it must never drift from the
//! generated enum that ships in the plugin policy protocol.
#![allow(clippy::expect_used, clippy::unwrap_used)]
use pacer_plugin_host::POLICY_EVENT_TYPES;
use pacer_plugin_policy_protocol::CapabilityEventsSubscribeParamsTypesItem;
use std::str::FromStr;

#[test]
fn host_observation_types_are_generated_policy_event_types() {
    // Every host-observable event name must be a valid generated event type.
    for event in POLICY_EVENT_TYPES {
        let parsed = CapabilityEventsSubscribeParamsTypesItem::from_str(event);
        assert!(
            parsed.is_ok(),
            "host event type {event:?} is not a generated policy event type"
        );
    }
}

#[test]
fn host_observation_types_cover_the_generated_control_and_discovery_events() {
    // `control` and `discovery.found` were added as v3 events; the host must
    // accept them like the TypeScript host so behavior does not diverge per host.
    for event in ["control", "discovery.found"] {
        assert!(
            POLICY_EVENT_TYPES.contains(&event),
            "host observation list must include {event:?}"
        );
    }
}
