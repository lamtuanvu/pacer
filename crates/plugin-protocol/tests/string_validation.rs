#![allow(clippy::unwrap_used)]
use pacer_plugin_protocol::{
    AgentSessionAttachmentParamsAgent, AgentSessionPrepareParamsAgent,
    AgentSessionPrepareParamsVersion, AgentSessionPrepareParamsWorkspace,
};
use std::{any::TypeId, str::FromStr};

#[test]
fn shared_validators_keep_public_types_and_validation_boundaries() {
    assert_ne!(
        TypeId::of::<AgentSessionAttachmentParamsAgent>(),
        TypeId::of::<AgentSessionPrepareParamsAgent>()
    );
    let valid = "é".repeat(64);
    let attachment = AgentSessionAttachmentParamsAgent::from_str(&valid).unwrap();
    let prepare = AgentSessionPrepareParamsAgent::from_str(&valid).unwrap();
    assert!(format!("{attachment:?}").starts_with("AgentSessionAttachmentParamsAgent("));
    assert!(format!("{prepare:?}").starts_with("AgentSessionPrepareParamsAgent("));
    assert_eq!(serde_json::to_value(&prepare).unwrap(), valid);
    assert_eq!(
        AgentSessionPrepareParamsAgent::from_str("")
            .unwrap_err()
            .to_string(),
        "shorter than 1 characters"
    );
    assert_eq!(
        AgentSessionPrepareParamsAgent::from_str(&"x".repeat(65))
            .unwrap_err()
            .to_string(),
        "longer than 64 characters"
    );
    assert!(AgentSessionPrepareParamsVersion::from_str(&"x".repeat(128)).is_ok());
    assert!(AgentSessionPrepareParamsVersion::from_str(&"x".repeat(129)).is_err());
    assert!(AgentSessionPrepareParamsWorkspace::from_str("").is_err());
    let valid_json = serde_json::to_string(&valid).unwrap();
    assert!(serde_json::from_str::<AgentSessionPrepareParamsAgent>(&valid_json).is_ok());
    let invalid_json = serde_json::to_string(&"x".repeat(65)).unwrap();
    let error = serde_json::from_str::<AgentSessionPrepareParamsAgent>(&invalid_json).unwrap_err();
    assert!(error.to_string().starts_with("longer than 64 characters"));
    assert!(serde_json::from_str::<AgentSessionPrepareParamsAgent>("123").is_err());
}
