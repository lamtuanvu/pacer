//! `pacer_plugin::types` covers every generated protocol crate (CRATE-3 area split).
use pacer_plugin::types::{
    AgentSessionPrepareParams, DecisionDecideParams, Manifest, PacerPluginProtocol1120, VERSION,
    WorkflowDefinitionsParams, error::ConversionError,
};

#[test]
fn types_name_decision_agent_session_and_entry_crate_items() {
    fn named<T>() -> &'static str {
        std::any::type_name::<T>()
    }
    assert!(named::<DecisionDecideParams>().starts_with("pacer_plugin_decision_protocol::"));
    assert!(
        named::<AgentSessionPrepareParams>().starts_with("pacer_plugin_agent_session_protocol::")
    );
    assert!(named::<WorkflowDefinitionsParams>().starts_with("pacer_plugin_workflow_protocol::"));
    assert!(named::<Manifest>().starts_with("pacer_plugin_protocol::"));
    assert!(named::<PacerPluginProtocol1120>().starts_with("pacer_plugin_protocol::"));
    assert!(named::<ConversionError>().starts_with("pacer_plugin_protocol::"));
    assert_eq!(VERSION, pacer_plugin_protocol::VERSION);
}
