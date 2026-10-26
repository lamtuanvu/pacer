#![allow(clippy::unwrap_used)]
use pacer_plugin_dispatch_protocol::{
    DecisionDecideParamsCandidatesItemId, ObservationObserveParamsScopeRunner,
};
use std::str::FromStr;

#[test]
fn independent_dispatch_types_keep_distinct_names_and_wire_validation() {
    assert_ne!(
        std::any::TypeId::of::<DecisionDecideParamsCandidatesItemId>(),
        std::any::TypeId::of::<ObservationObserveParamsScopeRunner>()
    );
    let id = DecisionDecideParamsCandidatesItemId::from_str("codex").unwrap();
    assert!(format!("{id:?}").starts_with("DecisionDecideParamsCandidatesItemId("));
    assert!(DecisionDecideParamsCandidatesItemId::from_str("").is_err());
    assert!(DecisionDecideParamsCandidatesItemId::from_str(&"a".repeat(257)).is_err());
    assert!(ObservationObserveParamsScopeRunner::from_str(&"a".repeat(257)).is_err());
    assert!(serde_json::from_str::<ObservationObserveParamsScopeRunner>("123").is_err());
    assert_eq!(serde_json::to_string(&id).unwrap(), "\"codex\"");
}
